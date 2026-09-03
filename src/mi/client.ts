import { getMiIOT, getMiNA, type MiIOT, type MiNA } from "mi-service-lite";
import type { Config } from "../config.js";
import type { ConversationRecord } from "../types.js";

export interface RawMiDevice {
  did: string;
  name: string;
  model: string;
  room_name?: string;
}

/**
 * 小米云协议封装：登录、对话轮询、TTS、任意设备 MIoT spec 控制。
 *
 * 注意：mi-service-lite 的 MiIOT 只封装了"登录时绑定设备"的 spec 调用，
 * 全屋控制需要按任意 did 调 /miotspec/* 端点——通过 _callMiotSpec 逃生舱
 * （下划线私有，运行时可访问）。所有对小米云的访问集中在此类，
 * 上游协议变更时只改这一个文件。
 */
export class MiClient {
  private miNA?: MiNA;
  private miIOT?: MiIOT;

  constructor(private readonly config: Pick<Config, "miUserId" | "miPassword" | "miDid" | "ttsCommand">) {}

  async init(): Promise<void> {
    const account = {
      userId: this.config.miUserId,
      password: this.config.miPassword,
      did: this.config.miDid,
    };
    this.miNA = await getMiNA(account);
    this.miIOT = await getMiIOT(account);
    if (!this.miNA || !this.miIOT) {
      throw new Error("小米云登录失败：请检查 MI_USER_ID / MI_PASSWORD / MI_DID");
    }
  }

  /**
   * 登录态自愈：服务未初始化或失效时重新登录一次。
   * force=true 时无条件重新 init（重新登录获取新 token）；
   * 重登也失败则异常向上冒泡（fail-fast 优于僵尸，运维方式是重启服务）。
   */
  async ensureAlive(force = false): Promise<void> {
    if (force || !this.miNA || !this.miIOT) {
      await this.init();
    }
  }

  private get na(): MiNA {
    if (!this.miNA) throw new Error("MiClient 未初始化，请先调用 init()");
    return this.miNA;
  }

  private get iot(): MiIOT {
    if (!this.miIOT) throw new Error("MiClient 未初始化，请先调用 init()");
    return this.miIOT;
  }

  /** 拉取小爱对话记录：只保留 TTS/LLM 单答案的用户主动消息（vendor 自 mi-gpt 过滤逻辑） */
  async getLatestRecords(limit: number): Promise<ConversationRecord[]> {
    const conversation: any = await this.na.getConversations({ limit });
    // mi-service-lite 失败（含重登失败）时返回 undefined 而非抛错——
    // 必须显式抛出，否则被 ?? [] 吞掉变成空列表，轮询沦为僵尸
    if (conversation === undefined) {
      throw new Error("拉取对话失败（可能登录态失效）");
    }
    const records: any[] = conversation?.records ?? [];
    return records
      .filter(
        (e) =>
          // answers 本身可能缺失（技能调用等非对话形状）：毒记录会让 filter 抛
          // TypeError 且停留在最近 10 条窗口内持续抛错——前置 Array.isArray 过滤掉
          Array.isArray(e.answers) &&
          e.answers.length === 1 &&
          ["TTS", "LLM"].includes(e.answers[0]?.type),
      )
      .map((e) => ({ text: e.query, timestamp: e.time }));
  }

  /** 盲发停止指令：打断小爱当前播报（不回读播放状态——目标机型不支持） */
  async pause(): Promise<void> {
    const ok = await this.na.pause();
    if (!ok) console.error("[MiClient] pause 指令下发失败");
  }

  /** 用小爱原生 TTS 播报文本（L09A: doAction(3,1,text)） */
  async speak(text: string): Promise<void> {
    let clean = text.replace(/\n\s*\n/g, "\n").trim();
    if (!clean) return;
    // LLM 违反"简短"约束返回长文时截断，避免小爱长时间霸占播报
    if (clean.length > 200) clean = clean.slice(0, 200) + "……";
    const ok = await this.iot.doAction(...this.config.ttsCommand, clean);
    if (!ok) console.error("[MiClient] TTS 播报指令下发失败");
  }

  /** 全屋设备列表 */
  async listRawDevices(): Promise<RawMiDevice[]> {
    const raw: any = await this.iot.getDevices();
    // 同 getLatestRecords：undefined 是登录态失效的信号，不能 ?? [] 吞掉，
    // 否则 DeviceCache 会用空列表覆盖好快照，全屋控制静默瘫痪
    if (raw === undefined) {
      throw new Error("拉取设备列表失败（可能登录态失效）");
    }
    const devices: any[] = raw;
    return devices.map((d) => ({
      did: String(d.did),
      name: d.name,
      model: d.model,
      room_name: d.room_name,
    }));
  }

  /** 逃生舱：直接调用 /miotspec/<command>，可指定任意 did */
  private async callSpec<T>(command: string, params: unknown): Promise<T> {
    const spec = (this.iot as any)._callMiotSpec?.bind(this.iot);
    if (typeof spec !== "function") {
      throw new Error("mi-service-lite 私有方法 _callMiotSpec 不可用，上游协议可能已变更");
    }
    return spec(command, params) as Promise<T>;
  }

  async specGet(did: string, entries: { siid: number; piid: number }[]) {
    return this.callSpec<any[]>("prop/get", entries.map((e) => ({ did, ...e })));
  }

  async specSet(did: string, siid: number, piid: number, value: unknown): Promise<boolean> {
    const res = await this.callSpec<any[]>("prop/set", [
      { did, siid, piid, value },
    ]);
    return res?.[0]?.code === 0;
  }

  async specAction(did: string, siid: number, aiid: number, args: unknown[]): Promise<boolean> {
    const res = await this.callSpec<any>("action", { did, siid, aiid, in: args });
    return res?.code === 0;
  }
}
