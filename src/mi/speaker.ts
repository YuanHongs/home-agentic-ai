import type { ConversationRecord } from "../types.js";
import { matchTrigger } from "../agent/trigger.js";

const FALLBACK_REPLY = "我脑子转不动了，稍后再试";
/** 连续重登失败达到该次数才放弃进程（约 10+ 秒真凭证错误/长期断网；瞬时抖动下轮自愈） */
const MAX_RELOGIN_FAILURES = 10;
/** TTS 语速启发式：约 4 字/秒，用于估测上一条播报剩余时长 */
const TTS_MS_PER_CHAR = 250;

export interface SpeakerDeps {
  poller: { poll(): Promise<ConversationRecord | undefined> };
  agent: { chat(text: string): Promise<string> };
  client: {
    pause(): Promise<void>;
    speak(text: string): Promise<void>;
    ensureAlive(force?: boolean): Promise<void>;
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
  /** 连续重登失败计数：poll 成功即归零 */
  private failCount = 0;
  /** 上一条 TTS 的下发时刻与字数（估测播完时长用，见 handle） */
  private lastSpeakAt = 0;
  private lastSpeakChars = 0;

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
      this.failCount = 0; // poll 成功（含空轮询）：登录态健康，失败计数归零
    } catch (err) {
      this.deps.onError?.(err as Error);
      // token 过期但实例仍在时不带 force 的 ensureAlive 会空转，必须强制重登。
      // mi-service-lite 把网络抖动和登录失效都表现为失败——一次 WiFi 抖动
      // 不该杀死常开进程：连续 MAX_RELOGIN_FAILURES 次重登失败（真凭证错误/
      // 长期断网）才让错误冒泡终止进程，瞬时抖动由下轮 poll 自愈
      try {
        await this.deps.client.ensureAlive(true);
        this.failCount = 0;
      } catch (reloginErr) {
        this.failCount++;
        this.deps.onError?.(reloginErr as Error);
        if (this.failCount >= MAX_RELOGIN_FAILURES) throw reloginErr;
      }
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
      console.log("🔥 " + payload);
      await this.waitTtsSettled(); // 上一条自己的 TTS 未播完时先等，避免 pause 掐断
      await this.deps.client.pause(); // 盲发打断小爱原生应答
      const reply = await this.deps.agent.chat(payload);
      await this.deps.client.speak(reply);
      this.lastSpeakAt = Date.now();
      this.lastSpeakChars = Math.min(reply.length, 200); // 与 client 的 200 字截断对齐
    } catch (err) {
      this.deps.onError?.(err as Error);
      await this.deps.client.speak(FALLBACK_REPLY).catch(() => {});
      this.lastSpeakAt = Date.now();
      this.lastSpeakChars = FALLBACK_REPLY.length;
    }
  }

  /**
   * 启发式：按 4 字/秒估测上一条 TTS 是否还在播。连续两条指令时，第二条的
   * pause() 会把第一条还在播的回复切掉——估测未播完则等到估测点再 pause。
   * 不精确（语速/标点停顿因机型而异），但足以覆盖最常见的"上一条刚开口"场景。
   */
  private async waitTtsSettled(): Promise<void> {
    const elapsed = Date.now() - this.lastSpeakAt;
    const remaining = this.lastSpeakChars * TTS_MS_PER_CHAR - elapsed;
    if (remaining > 0) await sleep(remaining);
  }
}
