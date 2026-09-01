import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { LLMClient, ChatMessage, LLMReply, ToolCall } from "../src/agent/llm.js";
import type { DeviceInfo, IRemoteDevice } from "../src/types.js";

const light: DeviceInfo = {
  did: "did.light",
  name: "客厅主灯",
  model: "philips.light.bulb",
  capabilities: [{ kind: "property", siid: 2, piid: 1, name: "On", desc: "开关", format: "bool", access: ["read", "write"] }],
};

const makeRemote = () => {
  const remote: IRemoteDevice & { resolveDevice(n: string): Promise<DeviceInfo | undefined> } = {
    listDevices: vi.fn(async () => [light]),
    getDeviceState: vi.fn(async () => ({ did: "did.light", properties: { On: true } })),
    executeAction: vi.fn(async () => ({ ok: true, message: "已执行 客厅主灯.开关" })),
    resolveDevice: vi.fn(async (n: string) => (n.includes("灯") ? light : undefined)),
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
      { content: "", toolCalls: [toolCall("t1", "control_device", { device: "客厅主灯", action: "On", value: false })] },
      { content: "晚安，灯已关", toolCalls: [] },
    ]);
    const remote = makeRemote();
    const agent = new Agent({ llm, devices: remote, systemPrompt });
    expect(await agent.chat("请关灯")).toBe("晚安，灯已关");
    expect(remote.executeAction).toHaveBeenCalledWith("did.light", "On", false);
    // 第二轮 LLM 收到 tool 结果消息
    const second = llm.received[1];
    expect(second.some((m) => m.role === "tool" && m.content.includes("已执行"))).toBe(true);
  });

  it("设备解析失败：把可用设备名单回喂给 LLM 自纠（仅一次）", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [toolCall("t1", "control_device", { device: "不存在的灯", action: "On", value: true })] },
      { content: "", toolCalls: [toolCall("t2", "control_device", { device: "客厅主灯", action: "On", value: true })] },
      { content: "好了", toolCalls: [] },
    ]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    expect(await agent.chat("开灯")).toBe("好了");
    const toolMsg = llm.received[1].find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("客厅主灯"); // 名单在错误信息里
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
});
