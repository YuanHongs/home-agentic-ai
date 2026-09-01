import type { ConversationRecord } from "../types.js";
import { matchTrigger } from "../agent/trigger.js";

const FALLBACK_REPLY = "我脑子转不动了，稍后再试";

export interface SpeakerDeps {
  poller: { poll(): Promise<ConversationRecord | undefined> };
  agent: { chat(text: string): Promise<string> };
  client: {
    pause(): Promise<void>;
    speak(text: string): Promise<void>;
    ensureAlive(): Promise<void>;
  };
  triggerWords: string[];
  pollIntervalMs: number;
  onError?: (err: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 主循环：轮询 → 触发词 → 串行处理（pause 打断小爱 → LLM → TTS 播报）。
 * 盲发策略：pause 不回读播放状态（目标机型 L09A/LX01 不支持）。
 */
export class SpeakerLoop {
  private running = false;
  /** 串行队列：对话与设备控制严格排队，防止并发打架 */
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  constructor(private readonly deps: SpeakerDeps) {}

  stop(): void {
    this.running = false;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      await this.step();
      await sleep(this.deps.pollIntervalMs);
    }
  }

  /**
   * 单步轮询 + 出错自愈（测试用 runOnce 复用）。
   * 返回 true 表示轮询已耗尽（poll 返回 undefined 且本轮无事可做）。
   */
  private async step(): Promise<boolean> {
    let msg: ConversationRecord | undefined;
    try {
      msg = await this.deps.poller.poll();
    } catch (err) {
      this.deps.onError?.(err as Error);
      await this.deps.client.ensureAlive(); // 登录态失效自愈
      return false;
    }
    if (!msg) return true;
    const { hit, payload } = matchTrigger(msg.text, this.deps.triggerWords);
    if (!hit) return false;
    this.enqueue(() => this.handle(payload));
    return false;
  }

  /** 处理积压消息直至队列为空（测试钩子） */
  async runOnce(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const exhausted = await this.step();
      await this.queue;
      if (exhausted && this.pendingCount === 0) break;
    }
    await this.queue;
  }

  private enqueue(task: () => Promise<void>): void {
    this.pendingCount++;
    this.queue = this.queue
      .then(task)
      .catch(() => {}) // 单条失败不阻断队列
      .finally(() => this.pendingCount--);
  }

  private async handle(payload: string): Promise<void> {
    try {
      await this.deps.client.pause(); // 盲发打断小爱原生应答
      const reply = await this.deps.agent.chat(payload);
      await this.deps.client.speak(reply);
    } catch (err) {
      this.deps.onError?.(err as Error);
      await this.deps.client.speak(FALLBACK_REPLY).catch(() => {});
    }
  }
}
