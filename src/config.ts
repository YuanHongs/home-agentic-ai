import { z } from "zod";

const envSchema = z.object({
  MI_USER_ID: z.string().min(1),
  MI_PASSWORD: z.string().min(1),
  MI_DID: z.string().min(1),
  TTS_COMMAND: z.string().default("3,1"),
  WAKEUP_COMMAND: z.string().default("3,2"),
  POLL_INTERVAL_MS: z.coerce.number().default(1000),
  TRIGGER_WORDS: z.string().default("请,小智"),
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),
  DEVICE_REFRESH_MS: z.coerce.number().default(30000),
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
  wakeUpCommand: [number, number];
  pollIntervalMs: number;
  triggerWords: string[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  deviceRefreshMs: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
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
  };
}
