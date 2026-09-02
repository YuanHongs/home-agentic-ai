import type { ConversationRecord } from "../types.js";

export type RecordFetcher = (limit: number) => Promise<ConversationRecord[]>;

/**
 * 游标：最后见过的秒级时间戳 + 该秒内已见条数。
 * 小米对话时间戳是秒级——同秒多条消息只靠 timestamp 无法区分先后，
 * 必须带同秒序号，否则同秒第二条会被严格 `>` 比较永久丢弃。
 */
interface Cursor {
  ts: number;
  /** 该秒内（时间正序）已消费到第几条：0 表示只建了 ts 未消费 */
  count: number;
}

/**
 * 对话轮询器：跟踪游标（最后见到的消息时间戳 + 同秒序号），把新消息按
 * 时间先后逐条吐出。首次调用只建游标不吐消息——防止响应启动前的历史对话。
 */
export class ConversationPoller {
  private cursor?: Cursor;
  private pending: ConversationRecord[] = [];

  constructor(private readonly fetcher: RecordFetcher) {}

  async poll(): Promise<ConversationRecord | undefined> {
    // 拉取最新的若干条（注入方保证从新到旧排序）
    const records = await this.fetcher(10);
    if (this.cursor === undefined) {
      // 首批记录全部视为已见（含最新秒内的全部同秒消息）
      const newest = records[0]?.timestamp ?? 0;
      this.cursor = {
        ts: newest,
        count: records.filter((r) => r.timestamp === newest).length,
      };
      return undefined;
    }
    const cursor = this.cursor;

    // 每条记录在其所在秒内的时间正序位置：
    // records 从新到旧，同秒组内第 k 个遇到（k=0 最新）的位置 = 组总数 - 1 - k
    const totals = new Map<number, number>();
    for (const r of records) totals.set(r.timestamp, (totals.get(r.timestamp) ?? 0) + 1);
    const seenInGroup = new Map<number, number>();
    const fresh: { rec: ConversationRecord; ts: number; pos: number }[] = [];
    for (const r of records) {
      const ts = r.timestamp;
      const k = seenInGroup.get(ts) ?? 0;
      seenInGroup.set(ts, k + 1);
      const pos = (totals.get(ts) ?? 0) - 1 - k;
      const isNew =
        ts > cursor.ts || (ts === cursor.ts && pos >= cursor.count);
      if (isNew) fresh.push({ rec: r, ts, pos });
    }

    // 时间正序入队（先秒级 ts，再秒内位置）
    fresh.sort((a, b) => a.ts - b.ts || a.pos - b.pos);
    if (fresh.length > 0) this.pending.push(...fresh.map((f) => f.rec));

    // 游标推进到本批见过的最新位置：本批全部记录都已见过
    if (records.length > 0) {
      const maxTs = Math.max(...records.map((r) => r.timestamp));
      const prevCount = cursor.ts === maxTs ? cursor.count : 0;
      this.cursor = { ts: maxTs, count: Math.max(prevCount, totals.get(maxTs) ?? 0) };
    }
    return this.pending.shift();
  }
}
