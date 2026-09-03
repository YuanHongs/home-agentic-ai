import { z } from "zod";

/**
 * 设备类型白名单默认值（CR4-S1）：只有这里的类型（MIoT spec URN 第 4 段）
 * 才向 LLM 开放控制能力。只收录"错了也就是开关/温度不对"的设备类型；
 * 门锁/摄像头/网关/报警器等高危类型一律不放行——设备仍进列表可见名称，
 * 但 LLM 看到的是"无可控能力"。
 */
const DEFAULT_DEVICE_TYPE_ALLOWLIST =
  "light,outlet,switch,air-conditioner,air-purifier,heater,humidifier,fan,curtain,airer,vacuum,television,fresh-air-system,bath-heater";

/** 默认白名单（数组形式，供 MiDeviceService 直接使用） */
export const DEFAULT_DEVICE_TYPE_ALLOWLIST_LIST = DEFAULT_DEVICE_TYPE_ALLOWLIST.split(",");

const envSchema = z.object({
  MI_USER_ID: z.string().min(1),
  MI_PASSWORD: z.string().min(1),
  MI_DID: z.string().min(1),
  TTS_COMMAND: z.string().default("3,1"),
  WAKEUP_COMMAND: z.string().default("3,2"),
  POLL_INTERVAL_MS: z.coerce
    .number()
    .min(500, "POLL_INTERVAL_MS 最低 500ms，过快轮询会打爆小米云接口")
    .default(1000),
  TRIGGER_WORDS: z.string().default("请,小智"),
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),
  DEVICE_REFRESH_MS: z.coerce.number().default(30000),
  // 设备黑名单：命中的设备不进入 LLM 可控清单（防语音控制门锁/音箱自身等高危对象）
  DEVICE_DENYLIST: z.string().default("xiaomi.wifispeaker"),
  // 设备类型白名单：MIoT spec URN 第 4 段的类型不在名单内时，该设备能力置空（主防线）
  DEVICE_TYPE_ALLOWLIST: z.string().default(DEFAULT_DEVICE_TYPE_ALLOWLIST),
});

const commandPair = (s: string): [number, number] => {
  const [a, b] = s.split(",").map((n) => Number(n.trim()));
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error(`指令格式非法: ${s}，应为 "siid,aiid"`);
  }
  return [a, b];
};

export interface Config {
  miUserId: string;
  miPassword: string;
  miDid: string;
  ttsCommand: [number, number];
  /** 预留：唤醒指令（当前未使用，保留解析以兼容） */
  wakeUpCommand: [number, number];
  pollIntervalMs: number;
  triggerWords: string[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  deviceRefreshMs: number;
  /** 设备黑名单（逗号分隔已拆分）：条目包含匹配设备 name 或 model（大小写不敏感） */
  deviceDenylist: string[];
  /** 设备类型白名单（逗号分隔已拆分、小写归一）：类型外的设备能力置空 */
  deviceTypeAllowlist: string[];
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // 带上校验消息（如 min(500) 的"最低 500ms"提示），不能只报字段名
    const fields = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`配置缺失或非法: ${fields}`);
  }
  const e = parsed.data;
  return {
    miUserId: e.MI_USER_ID,
    miPassword: e.MI_PASSWORD,
    miDid: e.MI_DID,
    ttsCommand: commandPair(e.TTS_COMMAND),
    wakeUpCommand: commandPair(e.WAKEUP_COMMAND),
    pollIntervalMs: e.POLL_INTERVAL_MS,
    triggerWords: e.TRIGGER_WORDS.split(",").map((s) => s.trim()).filter(Boolean),
    llmBaseUrl: e.LLM_BASE_URL,
    llmApiKey: e.LLM_API_KEY,
    llmModel: e.LLM_MODEL,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    deviceRefreshMs: e.DEVICE_REFRESH_MS,
    deviceDenylist: e.DEVICE_DENYLIST.split(",").map((s) => s.trim()).filter(Boolean),
    deviceTypeAllowlist: e.DEVICE_TYPE_ALLOWLIST.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
