import type { ConversationRecord } from "../types.js";

export type RecordFetcher = (limit: number) => Promise<ConversationRecord[]>;

/**
 * 对话轮询器：跟踪游标（最后见到的消息时间戳），把新消息按时间先后
 * 逐条吐出。首次调用只建游标不吐消息——防止响应启动前的历史对话。
 */
export class ConversationPoller {
  private cursor?: number;
  private pending: ConversationRecord[] = [];

  constructor(private readonly fetcher: RecordFetcher) {}

  async poll(): Promise<ConversationRecord | undefined> {
    // 拉取最新的若干条（注入方保证从新到旧排序）
    const records = await this.fetcher(10);
    if (this.cursor === undefined) {
      this.cursor = records[0]?.timestamp ?? 0;
      return undefined;
    }
    const fresh = records
      .filter((r) => r.timestamp > this.cursor!)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (fresh.length > 0) {
      this.pending.push(...fresh);
      this.cursor = fresh[fresh.length - 1].timestamp;
    }
    return this.pending.shift();
  }
}
