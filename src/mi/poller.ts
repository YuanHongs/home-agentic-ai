import type { ConversationRecord } from "../types.js";

export type RecordFetcher = (limit: number) => Promise<ConversationRecord[]>;

/** 已投递记录去重上限（FIFO 淘汰）：拉取窗口固定 10 条，200 条是窗口的 20 倍冗余 */
const MAX_DELIVERED = 200;

/**
 * 对话轮询器：把新消息按时间先后逐条吐出。
 *
 * 新鲜度判定（CR4 正确性波）：一条记录是"新"当且仅当
 *   1) timestamp >= 启动水位线（首批记录的最新时间戳，挡住服务启动前的历史），且
 *   2) 尚未投递过（delivered 集合，key = `timestamp|text`）。
 *
 * 旧实现用"秒级游标 + 同秒序号（pos）"判新，但小米对话时间戳是秒级、同秒
 * 多条只能靠窗口内位置推序号，而云端窗口会抖动（组内单条消失再恢复）：
 * 消息消失让组内总数变小、剩余记录的 pos 整体前移——既丢消息（恢复的那条
 * pos < 游标 count 被判旧）又重放（已投递条被顶到 pos >= count，确定性复现
 * [C,B,A] 丢 B 后投递 [A,C,C]）。pos 现在只用于同一批内的排序，不再参与判新；
 * "不重放"完全由 delivered 集合保证。
 *
 * 已知取舍：同秒且文本完全相同的两条真实消息会被去重成一条（timestamp|text
 * 无法区分）；delivered 超过 200 条后最早的 key 失去保护，但拉取窗口只有
 * 10 条，被淘汰的记录早已滑出窗口，正常流量下不可达。
 */
export class ConversationPoller {
  /** 启动水位线：首批记录的最新时间戳。不随轮询推进——推进会把"从未见过、
   *  恰好在窗口抖动期间漏掉"的记录判旧（丢消息）；重放防护交给 delivered。 */
  private floorTs?: number;
  private pending: ConversationRecord[] = [];
  /** 已投递（或首批已见）记录的 key → FIFO 淘汰依据。Map 保持插入序。 */
  private readonly delivered = new Map<string, true>();

  constructor(private readonly fetcher: RecordFetcher) {}

  private markDelivered(key: string): void {
    if (this.delivered.has(key)) return;
    this.delivered.set(key, true);
    if (this.delivered.size > MAX_DELIVERED) {
      const oldest = this.delivered.keys().next().value; // Map 按插入序迭代
      if (oldest !== undefined) this.delivered.delete(oldest);
    }
  }

  async poll(): Promise<ConversationRecord | undefined> {
    // 拉取最新的若干条（注入方保证从新到旧排序）
    const records = await this.fetcher(10);
    if (this.floorTs === undefined) {
      // 首批记录全部视为已见（含最新秒内的全部同秒消息）：永不吐出——
      // 防止响应启动前的历史对话被当作指令执行
      this.floorTs = records[0]?.timestamp ?? 0;
      for (const r of records) this.markDelivered(`${r.timestamp}|${r.text}`);
      return undefined;
    }

    // 每条记录在其所在秒内的时间正序位置（仅用于本批内排序）：
    // records 从新到旧，同秒组内第 k 个遇到（k=0 最新）的位置 = 组总数 - 1 - k
    const totals = new Map<number, number>();
    for (const r of records) totals.set(r.timestamp, (totals.get(r.timestamp) ?? 0) + 1);
    const seenInGroup = new Map<number, number>();
    const fresh: { rec: ConversationRecord; ts: number; pos: number }[] = [];
    for (const r of records) {
      const key = `${r.timestamp}|${r.text}`;
      // 已投递过的记录不再入队（无论窗口形状如何变化）——重放防线
      if (this.delivered.has(key)) continue;
      if (r.timestamp < this.floorTs) continue; // 启动前的历史
      const k = seenInGroup.get(r.timestamp) ?? 0;
      seenInGroup.set(r.timestamp, k + 1);
      const pos = (totals.get(r.timestamp) ?? 0) - 1 - k;
      fresh.push({ rec: r, ts: r.timestamp, pos });
      // 入队即标记已投递：进入 pending 的记录一定会被吐出；若等 shift 出队才
      // 标记，排队期间下一轮拉取会把同一条再判新一次（重复入队）
      this.markDelivered(key);
    }

    // 时间正序入队（先秒级 ts，再秒内位置）
    fresh.sort((a, b) => a.ts - b.ts || a.pos - b.pos);
    this.pending.push(...fresh.map((f) => f.rec));
    return this.pending.shift();
  }
}
