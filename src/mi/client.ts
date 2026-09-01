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

  /** 登录态自愈：服务未初始化或失效时重新登录一次 */
  async ensureAlive(): Promise<void> {
    if (!this.miNA || !this.miIOT) {
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
    const records: any[] = conversation?.records ?? [];
    return records
      .filter(
        (e) =>
          ["TTS", "LLM"].includes(e.answers[0]?.type) && e.answers.length === 1,
      )
      .map((e) => ({ text: e.query, timestamp: e.time }));
  }

  /** 盲发停止指令：打断小爱当前播报（不回读播放状态——目标机型不支持） */
  async pause(): Promise<void> {
    await this.na.pause();
  }

  /** 用小爱原生 TTS 播报文本（L09A: doAction(3,1,text)） */
  async speak(text: string): Promise<void> {
    const clean = text.replace(/\n\s*\n/g, "\n").trim();
    if (!clean) return;
    await this.iot.doAction(...this.config.ttsCommand, clean);
  }

  /** 全屋设备列表 */
  async listRawDevices(): Promise<RawMiDevice[]> {
    const devices: any[] = (await this.iot.getDevices()) ?? [];
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
