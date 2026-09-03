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

  it("同秒第二条在下一轮 poll 才出现时仍能吐出（delivered 只挡已投递过的）", async () => {
    let records = [rec("旧消息", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 水位线 = 100，"旧消息" 已见
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

  it("已消费记录从拉取窗口短暂消失后重现时不重放（delivered 去重）", async () => {
    let records: ConversationRecord[] = [rec("B", 170), rec("A", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 首批：A/B 已见
    records = [rec("C", 200), rec("B", 170), rec("A", 100)];
    expect(await p.poll()).toEqual(rec("C", 200)); // C 正常吐出
    // C 从拉取窗口短暂消失（云端分片抖动）
    records = [rec("B", 170), rec("A", 100)];
    expect(await p.poll()).toBeUndefined();
    // C 重现：不得被判为 fresh 而重复执行已执行过的设备指令
    records = [rec("C", 200), rec("B", 170), rec("A", 100)];
    expect(await p.poll()).toBeUndefined();
  });

  it("同秒拉取窗口收缩后恢复：已投递的同秒消息不重放", async () => {
    let records: ConversationRecord[] = [rec("二", 200), rec("一", 200), rec("旧", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 首批：二/一/旧 已见
    // 窗口里同秒只剩一条（"二" 消失）
    records = [rec("一", 200), rec("旧", 100)];
    expect(await p.poll()).toBeUndefined();
    // "二" 重现：不重放
    records = [rec("二", 200), rec("一", 200), rec("旧", 100)];
    expect(await p.poll()).toBeUndefined();
  });

  it("场景一：新秒组 [C,B,A] 瞬时丢 B 后恢复——B 正常投递、C 不重放", async () => {
    // CR4 正确性波：云端窗口抖动（组内单条消失再恢复）会让旧 pos 游标整体
    // 偏移——丢消息（B 恢复后 pos < 游标 count 被判旧）+ 重放（C 的 pos 被
    // 偏移顶到 >= count，确定性复现投递 [A,C,C]）。delivered 去重后 B 正常
    // 投递、C 不重放。
    let records: ConversationRecord[] = [rec("旧", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // 水位线 = 100，首批"旧"已见
    // 新秒 200 有三条消息（时间序 A→B→C），首次拉取时 B 被云端抖动吞掉
    records = [rec("C", 200), rec("A", 200)];
    expect(await p.poll()).toEqual(rec("A", 200)); // A 投递
    expect(await p.poll()).toEqual(rec("C", 200)); // C 投递
    expect(await p.poll()).toBeUndefined();
    // B 恢复：旧实现此处会丢 B 且重放 C；新实现 B 正常投递
    records = [rec("C", 200), rec("B", 200), rec("A", 200)];
    expect(await p.poll()).toEqual(rec("B", 200));
    expect(await p.poll()).toBeUndefined();
  });

  it("场景二：同一响应重复返回同一条新消息（跨轮或同轮内）——只投递一次", async () => {
    let records: ConversationRecord[] = [rec("旧", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll();
    records = [rec("新", 200), rec("旧", 100)];
    expect(await p.poll()).toEqual(rec("新", 200));
    // 云端把同一批记录原样再返回一轮：不得重复投递（重复执行设备指令）
    expect(await p.poll()).toBeUndefined();
    // 同一响应内重复出现同一条：也只投递一次
    records = [rec("重复", 300), rec("重复", 300), rec("旧", 100)];
    expect(await p.poll()).toEqual(rec("重复", 300));
    expect(await p.poll()).toBeUndefined();
  });

  it("delivered 去重上限 200 条 FIFO 淘汰：最早的 key 超限后失去去重保护", async () => {
    // 拉取窗口固定 10 条，200 条上限是窗口的 20 倍冗余——正常流量下不可能
    // 有已投递记录在被淘汰后仍留在窗口内；本用例固定住该边界语义
    let records: ConversationRecord[] = [rec("旧", 100)];
    const fetcher = vi.fn(async () => [...records]);
    const p = new ConversationPoller(fetcher);
    await p.poll(); // "旧" 进入 delivered（第 1 条）
    // 再投递 200 条新消息：delivered 达 201 条，"旧"（最早）被淘汰
    for (let ts = 101; ts <= 300; ts++) {
      records = [rec(`t${ts}`, ts)];
      await p.poll();
    }
    // "旧" 已不在 delivered 内：重现会再次投递（ts 100 >= 水位线 100）
    records = [rec("旧", 100)];
    expect(await p.poll()).toEqual(rec("旧", 100));
  });

  it("fetcher 抛错时 poll 透传异常（由上层重试策略处理）", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    });
    const p = new ConversationPoller(fetcher);
    await expect(p.poll()).rejects.toThrow("network down");
  });
});
