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
  return {
    poller,
    agent,
    client,
    triggerWords: ["请"],
    pollIntervalMs: 0,
    onError: vi.fn(),
  };
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

  it("重登连续失败 9 次内不终止（容忍瞬时网络抖动），下轮 poll 自愈", async () => {
    const deps = makeDeps({ messages: [] });
    deps.poller.poll = vi.fn(async () => {
      throw new Error("auth expired");
    });
    let fails = 0;
    deps.client.ensureAlive = vi.fn(async () => {
      fails++;
      if (fails <= 9) throw new Error("relogin failed");
    });
    const loop = new SpeakerLoop(deps);
    await expect(loop.runOnce()).resolves.toBeUndefined(); // 不冒泡
    expect(deps.client.ensureAlive).toHaveBeenCalled(); // 每轮都在重试重登
  });

  it("重登连续失败达到 10 次才冒泡终止（真凭证错误/长期断网）", async () => {
    const deps = makeDeps({ messages: [] });
    deps.onError = vi.fn();
    deps.poller.poll = vi.fn(async () => {
      throw new Error("auth expired");
    });
    deps.client.ensureAlive = vi.fn(async () => {
      throw new Error("relogin failed");
    });
    const loop = new SpeakerLoop(deps);
    await expect(loop.runOnce()).rejects.toThrow("relogin failed");
    expect(deps.client.ensureAlive).toHaveBeenCalledTimes(10);
    expect(deps.onError).toHaveBeenCalledWith(new Error("relogin failed"));
  });

  it("poll 成功后失败计数归零：抖动自愈后的失败重新计数", async () => {
    const deps = makeDeps({ messages: [{ text: "请开灯", timestamp: 100 }] });
    let pollShouldFail = true;
    const originalPoll = deps.poller.poll;
    deps.poller.poll = vi.fn(async () => {
      if (pollShouldFail) throw new Error("auth expired");
      return originalPoll();
    });
    let reloginFailures = 0;
    deps.client.ensureAlive = vi.fn(async () => {
      reloginFailures++;
      if (reloginFailures <= 3) throw new Error("relogin failed");
      pollShouldFail = false; // 重登成功，网络恢复
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(deps.agent.chat).toHaveBeenCalledTimes(1); // 自愈后正常处理消息
  });

  it("handle 开头打印 🔥 触发日志（成功路径可观测）", async () => {
    const deps = makeDeps({ messages: [{ text: "请开灯", timestamp: 100 }] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loop = new SpeakerLoop(deps);
      await loop.runOnce();
      expect(logSpy).toHaveBeenCalledWith("🔥 开灯");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("连续指令时第二条的 pause 等上一条 TTS 估测播完再发（不掐断自己）", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        messages: [
          { text: "请开灯", timestamp: 100 },
          { text: "请关灯", timestamp: 200 },
        ],
        agentReply: "一二三四五", // 5 字 × 250ms/字 ≈ 1250ms
      });
      const loop = new SpeakerLoop(deps);
      const done = loop.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      // 第一条无前序播报，pause 立即执行；第二条进入估测等待
      expect(deps.client.pause).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600); // 600ms < 1250ms，尚未 pause
      expect(deps.client.pause).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync(); // 估测播完
      expect(deps.client.pause).toHaveBeenCalledTimes(2);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
