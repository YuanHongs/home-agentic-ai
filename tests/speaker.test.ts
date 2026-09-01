import { describe, expect, it, vi } from "vitest";
import { SpeakerLoop } from "../src/mi/speaker.js";
import type { ConversationRecord } from "../src/types.js";

interface MockDeps {
  messages: ConversationRecord[]; // poll 依次吐出的消息
  agentReply?: string;
}

const makeDeps = (o: MockDeps) => {
  let i = 0;
  const agent = { chat: vi.fn(async () => o.agentReply ?? "好的") };
  const client = {
    pause: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    ensureAlive: vi.fn(async () => {}),
  };
  const poller = {
    poll: vi.fn(async () => {
      const msg = o.messages[i];
      // 服务会一直运行：模拟 poll 到最后一条后无限空轮询
      if (msg) i++;
      return msg;
    }),
  };
  return { poller, agent, client, triggerWords: ["请"], pollIntervalMs: 0 };
};

describe("SpeakerLoop", () => {
  it("命中触发词的消息进入 agent 并播报回复，未命中的丢弃", async () => {
    const deps = makeDeps({
      messages: [
        { text: "打开客厅灯", timestamp: 100 }, // 未命中，丢弃
        { text: "请开灯", timestamp: 200 },
      ],
    });
    const loop = new SpeakerLoop(deps);
    const done = loop.runOnce(); // 测试钩子：处理完当前积压消息
    await done;
    expect(deps.agent.chat).toHaveBeenCalledTimes(1);
    expect(deps.agent.chat).toHaveBeenCalledWith("开灯");
    expect(deps.client.speak).toHaveBeenCalledWith("好的");
    expect(deps.client.pause).toHaveBeenCalledTimes(1);
  });

  it("agent 抛错时播报兜底话术", async () => {
    const deps = makeDeps({ messages: [{ text: "请开灯", timestamp: 100 }] });
    deps.agent.chat = vi.fn(async () => {
      throw new Error("llm down");
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(deps.client.speak).toHaveBeenCalledWith(expect.stringContaining("转不动"));
  });

  it("两条触发消息串行处理（前一条 speak 完才开始下一条）", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      messages: [
        { text: "请开灯", timestamp: 100 },
        { text: "请关灯", timestamp: 200 },
      ],
    });
    deps.agent.chat = vi.fn(async (t: string) => {
      order.push(`chat:${t}`);
      return "ok";
    });
    deps.client.speak = vi.fn(async (t: string) => {
      order.push(`speak:${t}`);
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(order).toEqual(["chat:开灯", "speak:ok", "chat:关灯", "speak:ok"]);
  });

  it("轮询抛错时自愈（ensureAlive 强制重登）且不中断", async () => {
    let failed = false;
    const deps = makeDeps({ messages: [{ text: "请开灯", timestamp: 100 }] });
    const originalPoll = deps.poller.poll;
    deps.poller.poll = vi.fn(async () => {
      if (!failed) {
        failed = true;
        throw new Error("auth expired");
      }
      return originalPoll();
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(deps.client.ensureAlive).toHaveBeenCalledTimes(1);
    // 不带 force 的 ensureAlive 在 token 过期但实例仍在时空转，必须强制重登
    expect(deps.client.ensureAlive).toHaveBeenCalledWith(true);
    expect(deps.agent.chat).toHaveBeenCalledTimes(1);
  });

  it("重登也失败时错误冒泡终止（fail-fast，由运维重启恢复）", async () => {
    const deps = makeDeps({ messages: [] });
    deps.poller.poll = vi.fn(async () => {
      throw new Error("auth expired");
    });
    deps.client.ensureAlive = vi.fn(async () => {
      throw new Error("relogin failed");
    });
    const loop = new SpeakerLoop(deps);
    await expect(loop.runOnce()).rejects.toThrow("relogin failed");
  });
});
