import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { LLMClient, ChatMessage, LLMReply, ToolCall } from "../src/agent/llm.js";
import type { DeviceInfo, IRemoteDevice } from "../src/types.js";

const light: DeviceInfo = {
  did: "did.light",
  name: "客厅主灯",
  model: "philips.light.bulb",
  capabilities: [{ kind: "property", siid: 2, piid: 1, name: "Switch Status", desc: "开关", format: "bool", access: ["read", "write"] }],
};

const makeRemote = () => {
  const remote: IRemoteDevice & { resolveDevice(n: string): Promise<DeviceInfo | undefined> } = {
    listDevices: vi.fn(async () => [light]),
    getDeviceState: vi.fn(async () => ({ did: "did.light", properties: { "Switch Status": true } })),
    executeAction: vi.fn(async () => ({ ok: true, message: "已执行 客厅主灯.开关" })),
    resolveDevice: vi.fn(async (n: string) => (n === "客厅主灯" ? light : undefined)),
  };
  return remote;
};

/** 脚本化 fake LLM：按调用顺序吐出预设回复 */
class FakeLLM implements LLMClient {
  public received: ChatMessage[][] = [];
  constructor(public readonly replies: LLMReply[]) {}
  async chat(messages: ChatMessage[], _tools: unknown): Promise<LLMReply> {
    this.received.push(messages);
    const reply = this.replies.shift();
    if (!reply) throw new Error("FakeLLM 无更多预设回复");
    return reply;
  }
}

const toolCall = (id: string, name: string, args: object): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const systemPrompt = () => "SYS";

describe("Agent.chat", () => {
  it("纯文本回复：不调用工具直接返回", async () => {
    const llm = new FakeLLM([{ content: "你好呀", toolCalls: [] }]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    expect(await agent.chat("你好")).toBe("你好呀");
    expect(llm.received[0][0].role).toBe("system");
    expect(llm.received[0].at(-1)).toMatchObject({ role: "user", content: "你好" });
  });

  it("工具循环：LLM 先调 control_device，结果回喂后给最终回复", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [toolCall("t1", "control_device", { device: "客厅主灯", action: "Switch Status", value: false })] },
      { content: "晚安，灯已关", toolCalls: [] },
    ]);
    const remote = makeRemote();
    const agent = new Agent({ llm, devices: remote, systemPrompt });
    expect(await agent.chat("请关灯")).toBe("晚安，灯已关");
    expect(remote.executeAction).toHaveBeenCalledWith("did.light", "Switch Status", false);
    // 第二轮 LLM 收到 tool 结果消息
    const second = llm.received[1];
    expect(second.some((m) => m.role === "tool" && m.content.includes("已执行"))).toBe(true);
  });

  it("设备解析失败：把可用设备名单回喂给 LLM 自纠（仅一次）", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [toolCall("t1", "control_device", { device: "不存在的灯", action: "Switch Status", value: true })] },
      { content: "", toolCalls: [toolCall("t2", "control_device", { device: "客厅主灯", action: "Switch Status", value: true })] },
      { content: "好了", toolCalls: [] },
    ]);
    const remote = makeRemote();
    const agent = new Agent({ llm, devices: remote, systemPrompt });
    expect(await agent.chat("开灯")).toBe("好了");
    // t1 走失败分支：resolveDevice 未命中，不执行控制；仅 t2 自纠成功后执行一次
    expect(remote.executeAction).toHaveBeenCalledTimes(1);
    // 自纠消息：未找到 + 可用设备名单回喂给 LLM
    const toolMsg = llm.received[1].find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("未找到设备");
    expect(toolMsg.content).toContain("客厅主灯"); // 名单在错误信息里
    // t2 自纠成功后真正执行了控制
    expect(remote.executeAction).toHaveBeenCalledWith("did.light", "Switch Status", true);
  });

  it("工具参数 JSON 非法时回喂错误而不是崩溃", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [{ id: "t1", name: "control_device", arguments: "{bad json" }] },
      { content: "我重新说", toolCalls: [] },
    ]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    expect(await agent.chat("开灯")).toBe("我重新说");
    expect(llm.received[1].some((m) => m.role === "tool" && m.content.includes("参数"))).toBe(true);
  });

  it("超过 5 轮工具调用时终止并返回兜底话术", async () => {
    const loopReply: LLMReply = { content: "", toolCalls: [toolCall("t", "list_devices", {})] };
    const llm = new FakeLLM([loopReply, loopReply, loopReply, loopReply, loopReply, loopReply, loopReply]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    const reply = await agent.chat("看看设备");
    expect(reply).toContain("转不动");
  });

  it("对话历史保留最近轮次（环形缓冲）", async () => {
    const llm = new FakeLLM([{ content: "ok", toolCalls: [] }]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    await agent.chat("第一句");
    llm.received.length = 0;
    llm.replies.push({ content: "ok2", toolCalls: [] });
    await agent.chat("第二句");
    const messages = llm.received[0];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs.map((m) => m.content)).toEqual(["第一句", "第二句"]);
  });

  it("返回前打印回复完成日志，含实际执行的工具轮数（成功路径可观测）", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const llm = new FakeLLM([
        { content: "", toolCalls: [toolCall("t1", "list_devices", {})] },
        { content: "好了", toolCalls: [] },
      ]);
      const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
      await agent.chat("看看设备");
      expect(logSpy).toHaveBeenCalledWith("[agent] 回复完成，工具轮数:", 1);
      // 纯文本路径轮数为 0
      llm.replies.push({ content: "好", toolCalls: [] });
      await agent.chat("再看看");
      expect(logSpy).toHaveBeenLastCalledWith("[agent] 回复完成，工具轮数:", 0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("历史切片后首条历史消息保证是 user（部分国产端点要求首条非 system 为 user）", async () => {
    const llm = new FakeLLM([]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    // 构造 11 条历史：5 组 user/assistant + 尾部 user（空回复不落 assistant）
    for (let i = 0; i < 5; i++) {
      llm.replies.push({ content: `回${i}`, toolCalls: [] });
      await agent.chat(`问${i}`);
    }
    llm.replies.push({ content: "", toolCalls: [] }); // 空回复：只落 user
    await agent.chat("问5");
    // 此时历史 11 条，slice(-8) 若不修正会切成 assistant 开头
    llm.replies.push({ content: "ok", toolCalls: [] });
    await agent.chat("问6");
    const messages = llm.received.at(-1)!;
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });
});
