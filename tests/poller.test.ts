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

  it("同一秒内先后两条消息在同一次拉取中都逐条吐出（不因同秒被吞）", async () => {
    let records: ConversationRecord[] = [];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 空拉取建游标
    records = [rec("第二条", 100), rec("第一条", 100)]; // 从新到旧
    expect(await p.poll()).toEqual(rec("第一条", 100));
    expect(await p.poll()).toEqual(rec("第二条", 100));
    expect(await p.poll()).toBeUndefined();
  });

  it("同秒第二条在下一轮 poll 才出现时仍能吐出（游标含同秒序号）", async () => {
    let records = [rec("旧消息", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // cursor = {ts:100, 同秒已见 1 条}
    records = [rec("第一条", 200), rec("旧消息", 100)];
    expect(await p.poll()).toEqual(rec("第一条", 200));
    // 第二条与第一条同秒，晚一轮才出现在拉取结果里
    records = [rec("第二条", 200), rec("第一条", 200), rec("旧消息", 100)];
    expect(await p.poll()).toEqual(rec("第二条", 200));
    expect(await p.poll()).toBeUndefined();
  });

  it("跨秒混合时同秒消息保持时间顺序（秒内后发的后吐）", async () => {
    let records = [rec("旧", 50)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll();
    records = [rec("新秒", 200), rec("同秒二", 100), rec("同秒一", 100), rec("旧", 50)];
    expect(await p.poll()).toEqual(rec("同秒一", 100));
    expect(await p.poll()).toEqual(rec("同秒二", 100));
    expect(await p.poll()).toEqual(rec("新秒", 200));
    expect(await p.poll()).toBeUndefined();
  });

  it("已消费记录从拉取窗口短暂消失后重现时不重放（游标只进不退）", async () => {
    let records: ConversationRecord[] = [rec("B", 170), rec("A", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 游标 = {ts:170, count:1}
    records = [rec("C", 200), rec("B", 170), rec("A", 100)];
    expect(await p.poll()).toEqual(rec("C", 200)); // C 正常吐出
    // C 从拉取窗口短暂消失（云端分片抖动）：maxTs 回退到 170
    records = [rec("B", 170), rec("A", 100)];
    expect(await p.poll()).toBeUndefined();
    // C 重现：不得被判为 fresh 而重复执行已执行过的设备指令
    records = [rec("C", 200), rec("B", 170), rec("A", 100)];
    expect(await p.poll()).toBeUndefined();
  });

  it("同秒拉取窗口收缩时 count 不回退（保留同秒已消费条数）", async () => {
    let records: ConversationRecord[] = [rec("二", 200), rec("一", 200), rec("旧", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 游标 = {ts:200, count:2}
    // 窗口里同秒只剩一条（"二" 消失）：count 不得缩回 1
    records = [rec("一", 200), rec("旧", 100)];
    expect(await p.poll()).toBeUndefined();
    // "二" 重现：不重放
    records = [rec("二", 200), rec("一", 200), rec("旧", 100)];
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
