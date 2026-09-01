import { describe, expect, it, vi } from "vitest";
import { ConversationPoller } from "../src/mi/poller.js";
import type { ConversationRecord } from "../src/types.js";

const rec = (text: string, timestamp: number): ConversationRecord => ({
  text,
  timestamp,
});

describe("ConversationPoller", () => {
  it("首次 poll 只初始化游标，不返回消息", async () => {
    const fetcher = vi.fn(async () => [rec("你好", 100)]);
    const p = new ConversationPoller(fetcher);
    expect(await p.poll()).toBeUndefined();
  });

  it("出现新消息时返回；重复 poll 无新消息返回 undefined", async () => {
    let records = [rec("你好", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 初始化游标 = 100
    records = [rec("请开灯", 200), rec("你好", 100)];
    expect(await p.poll()).toEqual(rec("请开灯", 200));
    expect(await p.poll()).toBeUndefined();
  });

  it("一次出现多条新消息时，按时间顺序逐条返回", async () => {
    let records = [rec("你好", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll();
    records = [rec("第三条", 300), rec("第二条", 200), rec("第一条", 150)];
    expect(await p.poll()).toEqual(rec("第一条", 150));
    expect(await p.poll()).toEqual(rec("第二条", 200));
    expect(await p.poll()).toEqual(rec("第三条", 300));
    expect(await p.poll()).toBeUndefined();
  });

  it("fetcher 抛错时 poll 透传异常（由上层重试策略处理）", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    });
    const p = new ConversationPoller(fetcher);
    await expect(p.poll()).rejects.toThrow("network down");
  });
});
