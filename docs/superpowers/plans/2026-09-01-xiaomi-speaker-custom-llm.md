# 小爱音箱接入自订阅大模型——实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在常开设备上运行一个 Node.js 服务：轮询小爱音箱（Art L09A）的对话记录，命中触发词后由用户订阅的 LLM（OpenAI 兼容 API）进行意图理解与工具调用，通过小米云 MIoT spec 接口控制米家设备，并用小爱原生 TTS 播报回复。

**Architecture:** 三个解耦模块——小米接入层（vendor 简化版 mi-gpt 轮询逻辑 + mi-service-lite 协议包封装）、LLM 智能体层（Function Calling 循环）、设备缓存（定期快照注入 prompt）。智能体层只见 `IRemoteDevice` 抽象接口，不认识"小米"。

**Tech Stack:** TypeScript 5 (ESM, strict), Node.js >= 20, vitest, `mi-service-lite@^3.1.0`（小米云协议，MIT）, `openai@^4`（任意 OpenAI 兼容端点：GLM/DeepSeek/Kimi/Qwen）, `zod@^3`（配置校验）。运行用 `tsx`，环境变量用 `node --env-file`。

**Spec:** `docs/superpowers/specs/2026-09-01-xiaomi-speaker-custom-llm-design.md`

## Global Constraints

- Node.js >= 20，ESM（`"type": "module"`），TypeScript strict 模式
- 依赖仅限：`mi-service-lite`、`openai`、`zod`（运行时）；`typescript`、`tsx`、`vitest`、`@types/node`（开发时）。禁止引入数据库/Prisma（v1 对话历史用内存环形缓冲）
- AI 入口音箱 = 小爱音箱 Art（L09A）：`ttsCommand = [3,1]`，`wakeUpCommand = [3,2]`，无 playingCommand，**不支持流式响应，不依赖播放状态回读**（盲发策略）
- 触发模式：口令模式（默认 `请` / `小智` 前缀命中才进 LLM），触发词列表可配置
- 对话队列串行处理，禁止并发调用 LLM/设备控制
- 所有小米云调用集中在 `MiClient` 一个类里（含私有序访问的逃生舱），便于协议变更时单点修复
- LLM 调用 30 秒超时，失败播报兜底话术
- 测试一律 mock 外部服务（小米云 / LLM API），单测不允许真实网络调用
- 提交信息遵循 conventional commits（feat/fix/test/docs/chore）

---

### Task 1: 项目脚手架 + 配置模块 + 领域类型

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `src/types.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `loadConfig(env: Record<string,string|undefined>): Config`（zod 校验，抛错带字段名）
  - `Config` 类型：`{ miUserId, miPassword, miDid, ttsCommand: [number,number], wakeUpCommand: [number,number], pollIntervalMs, triggerWords: string[], llmBaseUrl, llmApiKey, llmModel, llmTimeoutMs, deviceRefreshMs }`
  - `src/types.ts` 导出：`DeviceInfo`, `DeviceCapability`, `DeviceState`, `ActionResult`, `IRemoteDevice`, `ConversationRecord`

- [ ] **Step 1: 创建项目骨架文件**

`package.json`:

```json
{
  "name": "home-agentic-ai",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/app.ts",
    "start": "tsx src/app.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "mi-service-lite": "^3.1.0",
    "openai": "^4.56.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.11.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

`.gitignore`:

```
node_modules/
.env
*.log
```

`.env.example`（先放占位，Task 12 补全注释）:

```
MI_USER_ID=
MI_PASSWORD=
MI_DID=
TTS_COMMAND=3,1
WAKEUP_COMMAND=3,2
POLL_INTERVAL_MS=1000
TRIGGER_WORDS=请,小智
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=30000
DEVICE_REFRESH_MS=30000
```

`src/types.ts`:

```ts
/** 设备能力（来自 MIoT spec） */
export interface DeviceCapability {
  kind: "property" | "action";
  /** MIoT spec 服务 ID */
  siid: number;
  /** 属性 ID（kind=property 时存在） */
  piid?: number;
  /** 动作 ID（kind=action 时存在） */
  aiid?: number;
  /** spec 规范名，如 On / Brightness / Play，作为 LLM 调用的能力标识 */
  name: string;
  /** 中文人话描述，如 "开关" / "亮度(0-100)" */
  desc: string;
  /** property 的值格式：bool / uint8 / string ... */
  format?: string;
  /** property 的访问权限 */
  access?: string[];
}

export interface DeviceInfo {
  did: string;
  /** 米家里的人类可读名称，如 "客厅主灯" */
  name: string;
  /** 设备型号，如 "philips.light.bulb" */
  model: string;
  room?: string;
  capabilities: DeviceCapability[];
}

export interface DeviceState {
  did: string;
  /** 能力名 -> 当前值，如 { On: true, Brightness: 80 } */
  properties: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** 智能体层看到的设备抽象——不感知小米协议 */
export interface IRemoteDevice {
  listDevices(): Promise<DeviceInfo[]>;
  getDeviceState(did: string): Promise<DeviceState>;
  executeAction(did: string, capability: string, value?: unknown): Promise<ActionResult>;
}

/** 小爱对话记录（已过滤） */
export interface ConversationRecord {
  text: string;
  /** 毫秒时间戳 */
  timestamp: number;
}
```

- [ ] **Step 2: 写配置模块的失败测试**

`tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  MI_USER_ID: "12345",
  MI_PASSWORD: "secret",
  MI_DID: "did.1",
  LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
  LLM_API_KEY: "sk-x",
  LLM_MODEL: "glm-4-plus",
};

describe("loadConfig", () => {
  it("必填项齐全时返回完整配置，可选项取默认值", () => {
    const c = loadConfig(validEnv);
    expect(c.miDid).toBe("did.1");
    expect(c.ttsCommand).toEqual([3, 1]); // L09A 默认
    expect(c.wakeUpCommand).toEqual([3, 2]);
    expect(c.pollIntervalMs).toBe(1000);
    expect(c.triggerWords).toEqual(["请", "小智"]);
    expect(c.llmTimeoutMs).toBe(30000);
    expect(c.deviceRefreshMs).toBe(30000);
  });

  it("TTS_COMMAND 支持逗号分隔自定义，如 LX01 的 5,1", () => {
    const c = loadConfig({ ...validEnv, TTS_COMMAND: "5,1" });
    expect(c.ttsCommand).toEqual([5, 1]);
  });

  it("TRIGGER_WORDS 空串得到空列表（全接管模式）", () => {
    const c = loadConfig({ ...validEnv, TRIGGER_WORDS: "" });
    expect(c.triggerWords).toEqual([]);
  });

  it("缺 LLM_API_KEY 时抛出带字段名的错误", () => {
    expect(() => loadConfig({ ...validEnv, LLM_API_KEY: undefined })).toThrow(
      /LLM_API_KEY/,
    );
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm install && npx vitest run tests/config.test.ts`
Expected: FAIL（`Cannot find module '../src/config.js'`）

- [ ] **Step 4: 实现配置模块**

`src/config.ts`:

```ts
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
```

- [ ] **Step 5: 运行测试确认通过，提交**

Run: `npm test && npm run typecheck`
Expected: 4 passed

```bash
git add -A && git commit -m "feat: 项目脚手架、配置模块与领域类型"
```

---

### Task 2: 触发词匹配器

**Files:**
- Create: `src/agent/trigger.ts`
- Test: `tests/trigger.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `matchTrigger(text: string, triggerWords: string[]): { hit: boolean; payload: string }` —— `hit` 为是否命中；`payload` 为剥掉触发词后的正文（trim 后），未命中时为空串

- [ ] **Step 1: 写失败测试**

`tests/trigger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchTrigger } from "../src/agent/trigger.js";

describe("matchTrigger", () => {
  it("前缀命中并剥离触发词", () => {
    expect(matchTrigger("请帮我关灯", ["请", "小智"])).toEqual({
      hit: true,
      payload: "帮我关灯",
    });
  });

  it("第二个触发词也命中", () => {
    expect(matchTrigger("小智 今天天气如何", ["请", "小智"])).toEqual({
      hit: true,
      payload: "今天天气如何",
    });

  });

  it("未命中前缀返回 hit=false", () => {
    expect(matchTrigger("打开客厅灯", ["请", "小智"])).toEqual({
      hit: false,
      payload: "",
    });
  });

  it("空触发词列表 = 全接管模式，任何非空文本都命中", () => {
    expect(matchTrigger("打开客厅灯", [])).toEqual({
      hit: true,
      payload: "打开客厅灯",
    });
    expect(matchTrigger("  ", [])).toEqual({ hit: false, payload: "" });
  });

  it("只有触发词没有正文的，视为未命中（避免空请求打 LLM）", () => {
    expect(matchTrigger("请", ["请", "小智"])).toEqual({ hit: false, payload: "" });
  });

  it("大小写不敏感、忽略首尾空白", () => {
    expect(matchTrigger(" 请讲个故事 ", ["请", "小智"])).toEqual({
      hit: true,
      payload: "讲个故事",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/trigger.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/agent/trigger.ts`:

```ts
export interface TriggerResult {
  hit: boolean;
  payload: string;
}

/** 口令模式：消息以任一触发词开头才进 LLM；触发词为空列表时全接管 */
export function matchTrigger(text: string, triggerWords: string[]): TriggerResult {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { hit: false, payload: "" };
  if (triggerWords.length === 0) return { hit: true, payload: text.trim() };
  for (const word of triggerWords) {
    const w = word.trim().toLowerCase();
    if (w && normalized.startsWith(w)) {
      const payload = text.trim().slice(w.length).trim();
      return payload ? { hit: true, payload } : { hit: false, payload: "" };
    }
  }
  return { hit: false, payload: "" };
}
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/trigger.test.ts`
Expected: 6 passed

```bash
git add -A && git commit -m "feat: 触发词匹配器（口令/全接管模式）"
```

---

### Task 3: 会话轮询器（游标 + 暂存队列）

**Files:**
- Create: `src/mi/poller.ts`
- Test: `tests/poller.test.ts`

**Interfaces:**
- Consumes: `ConversationRecord`（`src/types.ts`）
- Produces:
  - `type RecordFetcher = (limit: number) => Promise<ConversationRecord[]>`（返回记录**从新到旧**排序，由注入方保证）
  - `class ConversationPoller { constructor(fetcher: RecordFetcher); poll(): Promise<ConversationRecord | undefined> }` —— 每次 poll 返回 0 或 1 条**未处理过的最早**新消息；首次 poll 只初始化游标不返回消息（防响应历史消息）

- [ ] **Step 1: 写失败测试**

`tests/poller.test.ts`:

```ts
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

  it("fetcher 抛错时 poll 透传异常（由上层重试策略处理）", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    });
    const p = new ConversationPoller(fetcher);
    await expect(p.poll()).rejects.toThrow("network down");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/poller.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/mi/poller.ts`（简化 vendor 自 mi-gpt `speaker.ts` 的游标/暂存逻辑）:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/poller.test.ts`
Expected: 4 passed

```bash
git add -A && git commit -m "feat: 会话轮询器（游标+暂存队列，vendor 自 mi-gpt 简化）"
```

---

### Task 4: MiClient——小米云协议封装

**Files:**
- Create: `src/mi/client.ts`
- Test: `tests/mi-client.test.ts`

**Interfaces:**
- Consumes: `mi-service-lite` 的 `getMiNA`/`getMiIOT`（`MiNA.getConversations/getDevices/play/pause`、`MiIOT.doAction/getDevices`）；`Config`
- Produces: `class MiClient`，方法：
  - `init(): Promise<void>`（登录并绑定音箱设备）
  - `getLatestRecords(limit: number): Promise<ConversationRecord[]>`（过滤 TTS/LLM 单答案的记录，从新到旧）
  - `pause(): Promise<void>`（打断小爱当前播报）
  - `speak(text: string): Promise<void>`（经 `doAction(...ttsCommand, text)` 用小爱原生 TTS 播报）
  - `listRawDevices(): Promise<RawMiDevice[]>`（全屋设备列表，`RawMiDevice = { did: string; name: string; model: string; room_name?: string }`）
  - `specGet(did: string, entries: { siid: number; piid: number }[]): Promise<Record<string, unknown>[]>`、`specSet(did: string, siid: number, piid: number, value: unknown): Promise<boolean>`、`specAction(did: string, siid: number, aiid: number, args: unknown[]): Promise<boolean>`——**任意 did** 的设备控制（逃生舱）
  - `ensureAlive(): Promise<void>`（调用失败后重新 init 一次，仍失败则抛错）

- [ ] **Step 1: 写失败测试（mock mi-service-lite 与私有方法）**

`tests/mi-client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mi-service-lite", () => {
  const MiNA = class {
    pause = vi.fn(async () => true);
    getConversations = vi.fn(async () => ({
      records: [
        {
          query: "请开灯",
          time: 200,
          answers: [{ type: "TTS" }],
        },
        {
          query: "放首歌",
          time: 150,
          answers: [{ type: "TTS" }, { type: "Audio" }], // 播音乐：两条答案，过滤掉
        },
      ],
    }));
  };
  const MiIOT = class {
    doAction = vi.fn(async () => true);
    getDevices = vi.fn(async () => []);
    // 私有方法的逃生舱目标（运行时可通过 as any 访问）
    _callMiotSpec = vi.fn(async () => [{ code: 0, value: true }]);
  };
  return {
    getMiNA: vi.fn(async () => new MiNA()),
    getMiIOT: vi.fn(async () => new MiIOT()),
  };
});

import { getMiNA, getMiIOT } from "mi-service-lite";
import { MiClient } from "../src/mi/client.js";

const config = {
  miUserId: "u",
  miPassword: "p",
  miDid: "did.1",
  ttsCommand: [3, 1] as [number, number],
  wakeUpCommand: [3, 2] as [number, number],
};

describe("MiClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("init 登录并初始化 MiNA/MiIOT", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(getMiNA).toHaveBeenCalledWith(expect.objectContaining({ did: "did.1" }));
    expect(getMiIOT).toHaveBeenCalledWith(expect.objectContaining({ did: "did.1" }));
  });

  it("getLatestRecords 过滤非 TTS/LLM 单答案记录并映射字段", async () => {
    const c = new MiClient(config);
    await c.init();
    const records = await c.getLatestRecords(10);
    expect(records).toEqual([{ text: "请开灯", timestamp: 200 }]);
  });

  it("speak 走 ttsCommand 的 doAction", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.speak("晚安");
    const miIOT: any = (c as any).miIOT;
    expect(miIOT.doAction).toHaveBeenCalledWith(3, 1, "晚安");
  });

  it("specSet 对任意 did 调用 /miotspec/prop/set", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.specSet("did.other", 2, 1, true);
    const miIOT: any = (c as any).miIOT;
    expect(miIOT._callMiotSpec).toHaveBeenCalledWith("prop/set", [
      { did: "did.other", siid: 2, piid: 1, value: true },
    ]);
  });

  it("specAction 对任意 did 调用 /miotspec/action", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.specAction("did.other", 2, 1, [60]);
    const miIOT: any = (c as any).miIOT;
    expect(miIOT._callMiotSpec).toHaveBeenCalledWith("action", {
      did: "did.other",
      siid: 2,
      aiid: 1,
      in: [60],
    });
  });

  it("调用失败后 ensureAlive 重新登录一次", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(getMiNA).toHaveBeenCalledTimes(1);
    (c as any).miIOT = undefined; // 模拟登录态丢失
    await c.ensureAlive();
    expect(getMiNA).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mi-client.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/mi/client.ts`:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/mi-client.test.ts && npm run typecheck`
Expected: 6 passed

```bash
git add -A && git commit -m "feat: MiClient 小米云协议封装（含任意 did 的 miotspec 逃生舱）"
```

---

### Task 5: MIoT Spec 解析器

**Files:**
- Create: `src/mi/spec.ts`
- Test: `tests/spec.test.ts`, `tests/fixtures/spec-light.json`

**Interfaces:**
- Consumes: 无（纯函数 + 一个 fetch 函数注入）
- Produces:
  - `parseSpec(model: string, specJson: unknown): DeviceCapability[]`——从 home.miot-spec.com 的 instance JSON 提取可写属性与动作；常见能力名映射为中文 desc
  - `fetchSpec(model: string, httpGet: (url: string) => Promise<unknown>): Promise<unknown>`——从 `https://home.miot-spec.com/miot-spec-v2/instance?type=<model>` 拉取
  - 常见能力中文映射：`On→开关`、`Brightness→亮度`、`Color Temperature→色温`、`Mode→模式`、`Fan Level→风速`、`Target Temperature→目标温度`、`Air Conditioner→空调开关`、`Volume→音量`

- [ ] **Step 1: 准备 fixture（典型灯泡 spec，节选自 home.miot-spec.com 结构）**

`tests/fixtures/spec-light.json`:

```json
{
  "services": [
    { "siid": 1, "description": "Device Information", "properties": [] },
    {
      "siid": 2,
      "description": "Bulb",
      "properties": [
        { "piid": 1, "description": "On", "format": "bool", "access": ["read", "write"] },
        { "piid": 2, "description": "Brightness", "format": "uint8", "access": ["read", "write"], "value-range": [1, 100, 1] },
        { "piid": 3, "description": "Color Temperature", "format": "uint32", "access": ["read", "write"] },
        { "piid": 4, "description": "Uptime", "format": "uint64", "access": ["read"] }
      ],
      "actions": [
        { "aiid": 1, "description": "Toggle", "in": [] },
        { "aiid": 2, "description": "Blink", "in": [{ "piid": 1 }] }
      ]
    }
  ]
}
```

- [ ] **Step 2: 写失败测试**

`tests/spec.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/mi/spec.js";

const specJson = JSON.parse(
  readFileSync(new URL("./fixtures/spec-light.json", import.meta.url), "utf-8"),
);

describe("parseSpec", () => {
  it("提取可写属性与动作，只读属性排除", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    const names = caps.map((c) => c.name);
    expect(names).toContain("On");
    expect(names).toContain("Brightness");
    expect(names).not.toContain("Uptime"); // 只读，排除
    expect(names).toContain("Toggle");
  });

  it("属性带 siid/piid、格式与访问权限，常见名映射中文 desc", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    const on = caps.find((c) => c.name === "On")!;
    expect(on).toMatchObject({
      kind: "property",
      siid: 2,
      piid: 1,
      format: "bool",
      desc: "开关",
    });
    const brightness = caps.find((c) => c.name === "Brightness")!;
    expect(brightness.desc).toBe("亮度");
  });

  it("未知能力名保留英文原名作 desc，动作带 siid/aiid", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    const toggle = caps.find((c) => c.name === "Toggle")!;
    expect(toggle).toMatchObject({ kind: "action", siid: 2, aiid: 1, desc: "Toggle" });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/spec.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

`src/mi/spec.ts`:

```ts
import type { DeviceCapability } from "../types.js";

/** 常见能力名的中文映射（未命中时保留英文原名） */
const ZH: Record<string, string> = {
  On: "开关",
  Brightness: "亮度",
  "Color Temperature": "色温",
  Mode: "模式",
  "Fan Level": "风速",
  "Target Temperature": "目标温度",
  "Air Conditioner": "空调开关",
  Volume: "音量",
  Status: "状态",
  "Current Temperature": "当前温度",
};

interface SpecProperty {
  piid: number;
  description: string;
  format?: string;
  access?: string[];
}
interface SpecAction {
  aiid: number;
  description: string;
}
interface SpecService {
  siid: number;
  description: string;
  properties?: SpecProperty[];
  actions?: SpecAction[];
}

export function parseSpec(model: string, specJson: unknown): DeviceCapability[] {
  const services: SpecService[] = (specJson as { services?: SpecService[] })?.services ?? [];
  const caps: DeviceCapability[] = [];
  for (const svc of services) {
    if (svc.description === "Device Information") continue; // 无控制价值的标配服务
    for (const prop of svc.properties ?? []) {
      const writable = prop.access?.includes("write");
      if (!writable) continue;
      caps.push({
        kind: "property",
        siid: svc.siid,
        piid: prop.piid,
        name: prop.description,
        desc: ZH[prop.description] ?? prop.description,
        format: prop.format,
        access: prop.access,
      });
    }
    for (const act of svc.actions ?? []) {
      caps.push({
        kind: "action",
        siid: svc.siid,
        aiid: act.aiid,
        name: act.description,
        desc: ZH[act.description] ?? act.description,
      });
    }
  }
  return caps;
}

/** 从 home.miot-spec.com 拉取设备 spec（httpGet 注入以便测试） */
export async function fetchSpec(
  model: string,
  httpGet: (url: string) => Promise<unknown>,
): Promise<unknown> {
  return httpGet(`https://home.miot-spec.com/miot-spec-v2/instance?type=${encodeURIComponent(model)}`);
}
```

- [ ] **Step 5: 运行测试确认通过，提交**

Run: `npx vitest run tests/spec.test.ts`
Expected: 3 passed

```bash
git add -A && git commit -m "feat: MIoT spec 解析器（能力提取与中文映射）"
```

---

### Task 6: DeviceService——IRemoteDevice 实现（设备目录 + 控制执行）

**Files:**
- Create: `src/mi/devices.ts`
- Test: `tests/devices.test.ts`

**Interfaces:**
- Consumes: `MiClient`（Task 4）、`parseSpec`/`fetchSpec`（Task 5）、`IRemoteDevice` 等类型（Task 1）
- Produces:
  - `class MiDeviceService implements IRemoteDevice`，构造参数 `{ client: MiClient; fetchSpecJson?: (model: string) => Promise<unknown>; refreshMs?: number }`（`fetchSpecJson` 默认走网络，测试注入 fake）
  - `listDevices()`：拉设备列表 + spec，返回带 capabilities 的 `DeviceInfo[]`；spec 拉取失败的设备保留空 capabilities 并在 `room` 后附注
  - `getDeviceState(did)`：对该设备全部可读 property 做 `specGet`，返回 `{ did, properties: { On: true, ... } }`
  - `executeAction(did, capability, value?)`：按能力名查 capabilities——property 走 `specSet`，action 走 `specAction`（value 数组化后作 `in`）；返回 `{ ok, message }`；未知 did/能力返回 `ok:false` 且 message 列出可用项
  - `resolveDevice(nameOrDid: string): Promise<DeviceInfo | undefined>`：did 精确匹配或名称包含匹配（供 Agent 工具层做设备名解析与自纠提示）

- [ ] **Step 1: 写失败测试**

`tests/devices.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MiDeviceService } from "../src/mi/devices.js";
import type { MiClient } from "../src/mi/client.js";

const lightSpec = {
  services: [
    {
      siid: 2,
      description: "Bulb",
      properties: [
        { piid: 1, description: "On", format: "bool", access: ["read", "write"] },
      ],
      actions: [],
    },
  ],
};

const makeClient = () => ({
  listRawDevices: vi.fn(async () => [
    { did: "did.light", name: "客厅主灯", model: "philips.light.bulb" },
    { did: "did.ac", name: "卧室空调", model: "fake.ac" },
  ]),
  specGet: vi.fn(async () => [{ code: 0, did: "did.light", siid: 2, piid: 1, value: true }]),
  specSet: vi.fn(async () => true),
  specAction: vi.fn(async () => true),
} as unknown as MiClient & ReturnType<typeof makeClient>);

const makeService = (client = makeClient()) =>
  new MiDeviceService({
    client,
    fetchSpecJson: async (model) =>
      model === "philips.light.bulb" ? lightSpec : { services: [] },
  });

describe("MiDeviceService", () => {
  it("listDevices 合并设备列表与 spec 能力", async () => {
    const svc = makeService();
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(2);
    const light = devices.find((d) => d.did === "did.light")!;
    expect(light.name).toBe("客厅主灯");
    expect(light.capabilities).toHaveLength(1);
    expect(light.capabilities[0]).toMatchObject({ name: "On", desc: "开关", piid: 1 });
  });

  it("resolveDevice 支持名称包含匹配（'客厅的灯' -> 客厅主灯）", async () => {
    const svc = makeService();
    const d = await svc.resolveDevice("客厅的灯");
    expect(d?.did).toBe("did.light");
  });

  it("resolveDevice 支持 did 精确匹配", async () => {
    const svc = makeService();
    expect((await svc.resolveDevice("did.ac"))?.name).toBe("卧室空调");
  });

  it("executeAction 对 property 能力走 specSet", async () => {
    const client = makeClient();
    const svc = makeService(client);
    const r = await svc.executeAction("did.light", "On", false);
    expect(r.ok).toBe(true);
    expect(client.specSet).toHaveBeenCalledWith("did.light", 2, 1, false);
  });

  it("executeAction 对未知能力返回失败并列出可用能力（供 LLM 自纠）", async () => {
    const svc = makeService();
    const r = await svc.executeAction("did.light", "Brightness", 80);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("On");
  });

  it("executeAction 对不存在的设备返回失败并列出设备名单", async () => {
    const svc = makeService();
    const r = await svc.executeAction("did.ghost", "On", true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("客厅主灯");
    expect(r.message).toContain("卧室空调");
  });

  it("getDeviceState 返回能力名->值映射", async () => {
    const svc = makeService();
    const state = await svc.getDeviceState("did.light");
    expect(state).toEqual({ did: "did.light", properties: { On: true } });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/devices.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/mi/devices.ts`:

```ts
import type { MiClient } from "./client.js";
import { fetchSpec, parseSpec } from "./spec.js";
import type {
  ActionResult,
  DeviceCapability,
  DeviceInfo,
  DeviceState,
  IRemoteDevice,
} from "../types.js";

export interface DeviceServiceOptions {
  client: MiClient;
  /** spec 拉取函数（默认走网络，测试注入 fake） */
  fetchSpecJson?: (model: string) => Promise<unknown>;
}

const defaultFetchSpecJson = async (model: string): Promise<unknown> =>
  fetchSpec(model, async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`spec 拉取失败 ${res.status}: ${model}`);
    return res.json();
  });

/** 智能体层的设备门面：目录解析 + 控制执行，实现 IRemoteDevice */
export class MiDeviceService implements IRemoteDevice {
  private cache?: DeviceInfo[];

  constructor(private readonly opts: DeviceServiceOptions) {}

  private get specJson(): (model: string) => Promise<unknown> {
    return this.opts.fetchSpecJson ?? defaultFetchSpecJson;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (this.cache) return this.cache;
    const raw = await this.opts.client.listRawDevices();
    const devices = await Promise.all(
      raw.map(async (d): Promise<DeviceInfo> => {
        let capabilities: DeviceCapability[] = [];
        try {
          capabilities = parseSpec(d.model, await this.specJson(d.model));
        } catch {
          // spec 拉取失败不阻塞设备列表；该设备仅失去精细控制能力
        }
        return { did: d.did, name: d.name, model: d.model, room: d.room_name, capabilities };
      }),
    );
    this.cache = devices;
    return devices;
  }

  /** 设备名解析：did 精确匹配优先，其次名称包含匹配 */
  async resolveDevice(nameOrDid: string): Promise<DeviceInfo | undefined> {
    const devices = await this.listDevices();
    return (
      devices.find((d) => d.did === nameOrDid) ??
      devices.find((d) => d.name === nameOrDid) ??
      devices.find((d) => nameOrDid.includes(d.name) || d.name.includes(nameOrDid))
    );
  }

  async getDeviceState(did: string): Promise<DeviceState> {
    const device = (await this.listDevices()).find((d) => d.did === did);
    if (!device) throw new Error(`设备不存在: ${did}`);
    const readable = device.capabilities.filter(
      (c) => c.kind === "property" && c.piid !== undefined && c.access?.includes("read"),
    );
    if (readable.length === 0) return { did, properties: {} };
    const entries = readable.map((c) => ({ siid: c.siid, piid: c.piid! }));
    const res = await this.opts.client.specGet(did, entries);
    const properties: Record<string, unknown> = {};
    res.forEach((item: any, i: number) => {
      if (item?.code === 0) properties[readable[i].name] = item.value;
    });
    return { did, properties };
  }

  async executeAction(did: string, capability: string, value?: unknown): Promise<ActionResult> {
    const devices = await this.listDevices();
    const device = devices.find((d) => d.did === did);
    if (!device) {
      const list = devices.map((d) => `${d.name}(${d.did})`).join("、");
      return { ok: false, message: `未找到设备 ${did}。可用设备：${list}` };
    }
    const cap = device.capabilities.find((c) => c.name === capability);
    if (!cap) {
      const list = device.capabilities.map((c) => `${c.name}(${c.desc})`).join("、") || "无";
      return { ok: false, message: `设备 ${device.name} 没有能力 ${capability}。可用能力：${list}` };
    }
    try {
      const ok =
        cap.kind === "property"
          ? await this.opts.client.specSet(did, cap.siid, cap.piid!, value)
          : await this.opts.client.specAction(did, cap.siid, cap.aiid!, value === undefined ? [] : Array.isArray(value) ? value : [value]);
      return ok
        ? { ok: true, message: `已执行 ${device.name}.${cap.desc}` }
        : { ok: false, message: `设备 ${device.name} 执行 ${cap.desc} 失败（云端返回失败）` };
    } catch (err) {
      return { ok: false, message: `设备 ${device.name} 执行 ${cap.desc} 出错: ${(err as Error).message}` };
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/devices.test.ts && npm run typecheck`
Expected: 7 passed

```bash
git add -A && git commit -m "feat: MiDeviceService 实现 IRemoteDevice（目录解析+控制执行+自纠提示）"
```

---

### Task 7: 设备缓存（定期刷新快照）

**Files:**
- Create: `src/deviceCache.ts`
- Test: `tests/device-cache.test.ts`

**Interfaces:**
- Consumes: `IRemoteDevice`（Task 1 接口，测试用 fake 实现）
- Produces: `class DeviceCache`，构造参数 `{ remote: IRemoteDevice; refreshMs: number; onRefreshError?: (err: Error) => void }`：
  - `start(): void`（启动 setInterval 定期刷新；unref 定时器不阻塞进程退出）
  - `stop(): void`
  - `refresh(): Promise<void>`（立即刷新，失败时回调 `onRefreshError` 并保留旧快照）
  - `snapshot(): DeviceInfo[]`（最近一次成功刷新的结果，初始为 `[]`）

- [ ] **Step 1: 写失败测试**

`tests/device-cache.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceCache } from "../src/deviceCache.js";
import type { IRemoteDevice } from "../src/types.js";

const fakeRemote = (devices: DeviceInfo2[]): IRemoteDevice => ({
  listDevices: vi.fn(async () => devices),
  getDeviceState: vi.fn(async (did) => ({ did, properties: {} })),
  executeAction: vi.fn(async () => ({ ok: true, message: "ok" })),
});
type DeviceInfo2 = import("../src/types.js").DeviceInfo;

afterEach(() => vi.useRealTimers());

describe("DeviceCache", () => {
  it("refresh 后 snapshot 返回设备列表", async () => {
    const cache = new DeviceCache({ remote: fakeRemote([{ did: "1", name: "灯", model: "m", capabilities: [] }]), refreshMs: 30_000 });
    expect(cache.snapshot()).toEqual([]);
    await cache.refresh();
    expect(cache.snapshot()).toHaveLength(1);
  });

  it("refresh 失败时保留旧快照并回调 onRefreshError", async () => {
    const onError = vi.fn();
    let fail = false;
    const remote = fakeRemote([{ did: "1", name: "灯", model: "m", capabilities: [] }]);
    remote.listDevices = vi.fn(async () => {
      if (fail) throw new Error("cloud down");
      return [{ did: "1", name: "灯", model: "m", capabilities: [] }];
    });
    const cache = new DeviceCache({ remote, refreshMs: 30_000, onRefreshError: onError });
    await cache.refresh();
    expect(cache.snapshot()).toHaveLength(1);
    fail = true;
    await cache.refresh();
    expect(onError).toHaveBeenCalled();
    expect(cache.snapshot()).toHaveLength(1); // 旧快照仍在
  });

  it("start 定期刷新，stop 停止", async () => {
    vi.useFakeTimers();
    const remote = fakeRemote([{ did: "1", name: "灯", model: "m", capabilities: [] }]);
    const cache = new DeviceCache({ remote, refreshMs: 1000 });
    cache.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(remote.listDevices).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(remote.listDevices).toHaveBeenCalledTimes(2);
    cache.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(remote.listDevices).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/device-cache.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/deviceCache.ts`:

```ts
import type { DeviceInfo, IRemoteDevice } from "./types.js";

export interface DeviceCacheOptions {
  remote: IRemoteDevice;
  refreshMs: number;
  onRefreshError?: (err: Error) => void;
}

/** 设备快照缓存：定期刷新，失败保留旧快照（供 prompt 注入与工具校验） */
export class DeviceCache {
  private devices: DeviceInfo[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: DeviceCacheOptions) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs);
    this.timer.unref?.(); // 不阻塞进程退出
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      this.devices = await this.opts.remote.listDevices();
    } catch (err) {
      this.opts.onRefreshError?.(err as Error); // 保留旧快照
    }
  }

  snapshot(): DeviceInfo[] {
    return this.devices;
  }
}
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/device-cache.test.ts`
Expected: 3 passed

```bash
git add -A && git commit -m "feat: 设备缓存定期刷新（失败保留旧快照）"
```

---

### Task 8: Prompt 构建

**Files:**
- Create: `src/agent/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `DeviceInfo`（Task 1）
- Produces: `buildSystemPrompt(devices: DeviceInfo[]): string`——人格设定 + 规则 + 设备清单（每台设备一行：`名称 [型号] 可控: 开关(bool)、亮度`），含"控制设备前先用 control_device，设备名以清单为准"约束

- [ ] **Step 1: 写失败测试**

`tests/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import type { DeviceInfo } from "../src/types.js";

const devices: DeviceInfo[] = [
  {
    did: "did.light",
    name: "客厅主灯",
    model: "philips.light.bulb",
    capabilities: [
      { kind: "property", siid: 2, piid: 1, name: "On", desc: "开关", format: "bool", access: ["read", "write"] },
      { kind: "property", siid: 2, piid: 2, name: "Brightness", desc: "亮度", format: "uint8", access: ["read", "write"] },
    ],
  },
  {
    did: "did.ac",
    name: "卧室空调",
    model: "fake.ac",
    capabilities: [],
  },
];

describe("buildSystemPrompt", () => {
  it("包含设备名、能力中文描述与格式", () => {
    const p = buildSystemPrompt(devices);
    expect(p).toContain("客厅主灯");
    expect(p).toContain("开关(bool)");
    expect(p).toContain("亮度");
    expect(p).toContain("卧室空调");
  });

  it("包含设备名约束与回复风格要求", () => {
    const p = buildSystemPrompt(devices);
    expect(p).toContain("control_device");
    expect(p).toContain("简短");
    expect(p).toContain("口头播报");
  });

  it("无设备时也能生成（提示暂无设备）", () => {
    const p = buildSystemPrompt([]);
    expect(p).toContain("暂无设备");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/agent/prompt.ts`:

```ts
import type { DeviceInfo } from "../types.js";

/** 组装 system prompt：人格 + 规则 + 设备能力快照（人类可读名称，非 did） */
export function buildSystemPrompt(devices: DeviceInfo[]): string {
  const deviceLines =
    devices.length === 0
      ? "- （当前暂无设备快照，如需控制设备请先调用 list_devices）"
      : devices
          .map((d) => {
            const caps =
              d.capabilities
                .map((c) => (c.format ? `${c.desc}(${c.format})` : c.desc))
                .join("、") || "无可控能力";
            const room = d.room ? `@${d.room}` : "";
            return `- ${d.name}${room} [${d.model}] 可控: ${caps}`;
          })
          .join("\n");

  return `你是一个家庭语音助手，通过智能音箱与用户对话。你的回复将被转成语音播报，所以：
- 回复必须简短（一般不超过两句话），口语化，适合口头播报
- 不要使用列表、表格、代码或任何符号格式

## 设备控制
当前家中的设备清单（名称以清单为准）：
${deviceLines}

控制设备时调用 control_device 工具，device 参数用清单中的设备名。查询设备状态用 get_device_state，查看完整清单用 list_devices。
用户说模糊意图（如"我要睡了"、"有点冷"）时，主动推断并调用合适的设备组合，执行完毕后用一句话告知结果。设备执行失败时如实说明。`;
}
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/prompt.test.ts`
Expected: 3 passed

```bash
git add -A && git commit -m "feat: system prompt 构建（设备快照注入）"
```

---

### Task 9: Agent——LLM 工具循环

**Files:**
- Create: `src/agent/llm.ts`, `src/agent/tools.ts`, `src/agent/agent.ts`
- Test: `tests/agent.test.ts`

**Interfaces:**
- Consumes: `IRemoteDevice`（Task 1）、`MiDeviceService.resolveDevice/executeAction/getDeviceState/listDevices`（Task 6）、`buildSystemPrompt`（Task 8）、`Config.llm*`（Task 1）
- Produces:
  - `LLMClient` 接口（`src/agent/llm.ts`）：`chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMReply>`，其中 `ChatMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }`，`ToolCall = { id: string; name: string; arguments: string }`，`LLMReply = { content: string; toolCalls: ToolCall[] }`；实现类 `OpenAICompatLLM`（openai SDK，`baseURL`/`apiKey`/`model`/`timeout` 可配）
  - `buildToolDefs(): ToolDef[]`（`src/agent/tools.ts`）：`list_devices` / `get_device_state` / `control_device` 三个工具的 JSON Schema 定义
  - `class Agent`（`src/agent/agent.ts`）：构造参数 `{ llm: LLMClient; devices: IRemoteDevice & { resolveDevice(nameOrDid: string): Promise<DeviceInfo | undefined> }; systemPrompt: () => string }`
    - `chat(userText: string): Promise<string>`——工具循环最多 5 轮：LLM 返回 toolCalls 则执行并把结果作为 tool 消息回喂；返回纯文本则结束。执行器：`control_device` 先 `resolveDevice` 解析名称，未找到时返回设备名单让 LLM 自纠；`get_device_state` 同理
    - 内存对话历史：环形缓冲保留最近 8 条 user/assistant 消息（tool 中间消息不入历史）

- [ ] **Step 1: 写失败测试**

`tests/agent.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { LLMClient, ChatMessage, LLMReply, ToolCall } from "../src/agent/llm.js";
import type { DeviceInfo, IRemoteDevice } from "../src/types.js";

const light: DeviceInfo = {
  did: "did.light",
  name: "客厅主灯",
  model: "philips.light.bulb",
  capabilities: [{ kind: "property", siid: 2, piid: 1, name: "On", desc: "开关", format: "bool", access: ["read", "write"] }],
};

const makeRemote = () => {
  const remote: IRemoteDevice & { resolveDevice(n: string): Promise<DeviceInfo | undefined> } = {
    listDevices: vi.fn(async () => [light]),
    getDeviceState: vi.fn(async () => ({ did: "did.light", properties: { On: true } })),
    executeAction: vi.fn(async () => ({ ok: true, message: "已执行 客厅主灯.开关" })),
    resolveDevice: vi.fn(async (n: string) => (n.includes("灯") ? light : undefined)),
  };
  return remote;
};

/** 脚本化 fake LLM：按调用顺序吐出预设回复 */
class FakeLLM implements LLMClient {
  public received: ChatMessage[][] = [];
  constructor(private readonly replies: LLMReply[]) {}
  async chat(messages: ChatMessage[], _tools: unknown): Promise<LLMReply> {
    this.received.push(messages);
    const reply = this.replies.shift();
    if (!reply) throw new Error("FakeLLM 无更多预设回复");
    return reply;
  }
}

const toolCall = (id: string, name: string, args: object): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const systemPrompt = () => "SYS";

describe("Agent.chat", () => {
  it("纯文本回复：不调用工具直接返回", async () => {
    const llm = new FakeLLM([{ content: "你好呀", toolCalls: [] }]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    expect(await agent.chat("你好")).toBe("你好呀");
    expect(llm.received[0][0].role).toBe("system");
    expect(llm.received[0].at(-1)).toMatchObject({ role: "user", content: "你好" });
  });

  it("工具循环：LLM 先调 control_device，结果回喂后给最终回复", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [toolCall("t1", "control_device", { device: "客厅主灯", action: "On", value: false })] },
      { content: "晚安，灯已关", toolCalls: [] },
    ]);
    const remote = makeRemote();
    const agent = new Agent({ llm, devices: remote, systemPrompt });
    expect(await agent.chat("请关灯")).toBe("晚安，灯已关");
    expect(remote.executeAction).toHaveBeenCalledWith("did.light", "On", false);
    // 第二轮 LLM 收到 tool 结果消息
    const second = llm.received[1];
    expect(second.some((m) => m.role === "tool" && m.content.includes("已执行"))).toBe(true);
  });

  it("设备解析失败：把可用设备名单回喂给 LLM 自纠（仅一次）", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [toolCall("t1", "control_device", { device: "不存在的灯", action: "On", value: true })] },
      { content: "", toolCalls: [toolCall("t2", "control_device", { device: "客厅主灯", action: "On", value: true })] },
      { content: "好了", toolCalls: [] },
    ]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    expect(await agent.chat("开灯")).toBe("好了");
    const toolMsg = llm.received[1].find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("客厅主灯"); // 名单在错误信息里
  });

  it("工具参数 JSON 非法时回喂错误而不是崩溃", async () => {
    const llm = new FakeLLM([
      { content: "", toolCalls: [{ id: "t1", name: "control_device", arguments: "{bad json" }] },
      { content: "我重新说", toolCalls: [] },
    ]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    expect(await agent.chat("开灯")).toBe("我重新说");
    expect(llm.received[1].some((m) => m.role === "tool" && m.content.includes("参数"))).toBe(true);
  });

  it("超过 5 轮工具调用时终止并返回兜底话术", async () => {
    const loopReply: LLMReply = { content: "", toolCalls: [toolCall("t", "list_devices", {})] };
    const llm = new FakeLLM([loopReply, loopReply, loopReply, loopReply, loopReply, loopReply, loopReply]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    const reply = await agent.chat("看看设备");
    expect(reply).toContain("转不动");
  });

  it("对话历史保留最近轮次（环形缓冲）", async () => {
    const llm = new FakeLLM([{ content: "ok", toolCalls: [] }]);
    const agent = new Agent({ llm, devices: makeRemote(), systemPrompt });
    await agent.chat("第一句");
    llm.received.length = 0;
    llm.replies.push({ content: "ok2", toolCalls: [] });
    await agent.chat("第二句");
    const messages = llm.received[0];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs.map((m) => m.content)).toEqual(["第一句", "第二句"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三个文件**

`src/agent/llm.ts`:

```ts
import OpenAI from "openai";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串形式的参数 */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LLMReply {
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface LLMClient {
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMReply>;
}

/** OpenAI 兼容端点适配（GLM/DeepSeek/Kimi/Qwen 等） */
export class OpenAICompatLLM implements LLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }) {
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      maxRetries: 1,
    });
    this.model = opts.model;
  }

  async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMReply> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ ...m, content: m.content || undefined }) as any),
      tools: tools as any,
    });
    const choice = res.choices[0]?.message;
    return {
      content: choice?.content ?? "",
      toolCalls: (choice?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
    };
  }
}
```

`src/agent/tools.ts`:

```ts
import type { ToolDef } from "./llm.js";

export function buildToolDefs(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "list_devices",
        description: "列出家中所有智能设备及其可控能力",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_device_state",
        description: "查询某台设备的当前状态（如开关、亮度、温度）",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备名称" },
          },
          required: ["device"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "control_device",
        description: "控制一台设备。action 为能力名（如 On/Brightness），value 为目标值",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备名称" },
            action: { type: "string", description: "能力名，如 On" },
            value: { description: "目标值：bool/数字/字符串，action 类能力可省略" },
          },
          required: ["device", "action"],
        },
      },
    },
  ];
}
```

`src/agent/agent.ts`:

```ts
import type { DeviceInfo, IRemoteDevice } from "../types.js";
import type { ChatMessage, LLMClient, ToolCall } from "./llm.js";
import { buildToolDefs } from "./tools.js";

const MAX_TOOL_ROUNDS = 5;
const HISTORY_LIMIT = 8;
const FALLBACK_REPLY = "我脑子转不动了，稍后再试";

interface ToolResult {
  ok: boolean;
  message: string;
}

export interface AgentOptions {
  llm: LLMClient;
  devices: IRemoteDevice & {
    resolveDevice(nameOrDid: string): Promise<DeviceInfo | undefined>;
  };
  systemPrompt: () => string;
}

/** LLM 智能体：工具调用循环 + 内存对话历史 */
export class Agent {
  private history: ChatMessage[] = [];
  private readonly tools = buildToolDefs();

  constructor(private readonly opts: AgentOptions) {}

  async chat(userText: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.opts.systemPrompt() },
      ...this.history,
      { role: "user", content: userText },
    ];
    try {
      let reply = await this.opts.llm.chat(messages, this.tools);
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (reply.toolCalls.length === 0) {
          this.remember(userText, reply.content);
          return reply.content || FALLBACK_REPLY;
        }
        messages.push({
          role: "assistant",
          content: reply.content,
          tool_calls: reply.toolCalls,
        });
        for (const tc of reply.toolCalls) {
          const result = await this.runTool(tc);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.message });
        }
        reply = await this.opts.llm.chat(messages, this.tools);
      }
      this.remember(userText, "");
      return FALLBACK_REPLY;
    } catch (err) {
      return FALLBACK_REPLY; // 上层（speaker）负责播报兜底
    }
  }

  private remember(userText: string, assistantText: string): void {
    this.history.push({ role: "user", content: userText });
    if (assistantText) this.history.push({ role: "assistant", content: assistantText });
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
  }

  private async runTool(tc: ToolCall): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments || "{}");
    } catch {
      return { ok: false, message: `工具参数不是合法 JSON: ${tc.arguments}` };
    }
    const d = this.opts.devices;
    switch (tc.name) {
      case "list_devices": {
        const devices = await d.listDevices();
        const lines = devices.map((x) => `${x.name}（${x.model}）`);
        return { ok: true, message: lines.join("\n") || "家中暂无设备" };
      }
      case "get_device_state": {
        const name = String(args.device ?? "");
        const device = await d.resolveDevice(name);
        if (!device) return { ok: false, message: `未找到设备「${name}」，可用设备：${(await d.listDevices()).map((x) => x.name).join("、")}` };
        const state = await d.getDeviceState(device.did);
        return { ok: true, message: JSON.stringify(state.properties) };
      }
      case "control_device": {
        const name = String(args.device ?? "");
        const device = await d.resolveDevice(name);
        if (!device) return { ok: false, message: `未找到设备「${name}」，可用设备：${(await d.listDevices()).map((x) => x.name).join("、")}` };
        return d.executeAction(device.did, String(args.action ?? ""), args.value);
      }
      default:
        return { ok: false, message: `未知工具: ${tc.name}` };
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/agent.test.ts && npm run typecheck`
Expected: 6 passed

```bash
git add -A && git commit -m "feat: Agent 工具循环（Function Calling + 自纠 + 兜底）"
```

---

### Task 10: Speaker 主循环（串行队列 + 盲发打断）

**Files:**
- Create: `src/mi/speaker.ts`
- Test: `tests/speaker.test.ts`

**Interfaces:**
- Consumes: `ConversationPoller`（Task 3）、`matchTrigger`（Task 2）、`Agent`（Task 9）、`MiClient`（Task 4）、`Config.pollIntervalMs/triggerWords`（Task 1）
- Produces:
  - `interface SpeakerDeps { poller: { poll(): Promise<ConversationRecord | undefined> }; agent: { chat(text: string): Promise<string> }; client: { pause(): Promise<void>; speak(text: string): Promise<void>; ensureAlive(): Promise<void> }; triggerWords: string[]; pollIntervalMs: number; onError?: (err: Error) => void }`
  - `class SpeakerLoop { constructor(deps: SpeakerDeps); start(): Promise<void>; stop(): void }`
  - 行为：轮询到新消息 → 命中触发词 → **入串行队列**；队列处理器：`pause()` 打断小爱 → `agent.chat(payload)` → `speak(reply)`；未命中触发词的消息直接丢弃；单条处理失败时 `speak(兜底话术)` 并继续下一条；轮询本身抛错（如登录态失效）→ `ensureAlive()` 自愈一次并继续

- [ ] **Step 1: 写失败测试**

`tests/speaker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SpeakerLoop } from "../src/mi/speaker.js";
import type { ConversationRecord } from "../src/types.js";

interface MockDeps {
  messages: ConversationRecord[]; // poll 依次吐出的消息
  agentReply?: string;
}

const makeDeps = (o: MockDeps) => {
  let i = 0;
  const agent = { chat: vi.fn(async () => o.agentReply ?? "好的") };
  const client = {
    pause: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    ensureAlive: vi.fn(async () => {}),
  };
  const poller = {
    poll: vi.fn(async () => {
      const msg = o.messages[i];
      // 服务会一直运行：模拟 poll 到最后一条后无限空轮询
      if (msg) i++;
      return msg;
    }),
  };
  return { poller, agent, client, triggerWords: ["请"], pollIntervalMs: 0 };
};

describe("SpeakerLoop", () => {
  it("命中触发词的消息进入 agent 并播报回复，未命中的丢弃", async () => {
    const deps = makeDeps({
      messages: [
        { text: "打开客厅灯", timestamp: 100 }, // 未命中，丢弃
        { text: "请开灯", timestamp: 200 },
      ],
    });
    const loop = new SpeakerLoop(deps);
    const done = loop.runOnce(); // 测试钩子：处理完当前积压消息
    await done;
    expect(deps.agent.chat).toHaveBeenCalledTimes(1);
    expect(deps.agent.chat).toHaveBeenCalledWith("开灯");
    expect(deps.client.speak).toHaveBeenCalledWith("好的");
    expect(deps.client.pause).toHaveBeenCalledTimes(1);
  });

  it("agent 抛错时播报兜底话术", async () => {
    const deps = makeDeps({ messages: [{ text: "请开灯", timestamp: 100 }] });
    deps.agent.chat = vi.fn(async () => {
      throw new Error("llm down");
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(deps.client.speak).toHaveBeenCalledWith(expect.stringContaining("转不动"));
  });

  it("两条触发消息串行处理（前一条 speak 完才开始下一条）", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      messages: [
        { text: "请开灯", timestamp: 100 },
        { text: "请关灯", timestamp: 200 },
      ],
    });
    deps.agent.chat = vi.fn(async (t: string) => {
      order.push(`chat:${t}`);
      return "ok";
    });
    deps.client.speak = vi.fn(async (t: string) => {
      order.push(`speak:${t}`);
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(order).toEqual(["chat:开灯", "speak:ok", "chat:关灯", "speak:ok"]);
  });

  it("轮询抛错时自愈（ensureAlive）且不中断", async () => {
    let failed = false;
    const deps = makeDeps({ messages: [{ text: "请开灯", timestamp: 100 }] });
    const originalPoll = deps.poller.poll;
    deps.poller.poll = vi.fn(async () => {
      if (!failed) {
        failed = true;
        throw new Error("auth expired");
      }
      return originalPoll();
    });
    const loop = new SpeakerLoop(deps);
    await loop.runOnce();
    expect(deps.client.ensureAlive).toHaveBeenCalledTimes(1);
    expect(deps.agent.chat).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/speaker.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/mi/speaker.ts`:

```ts
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

  /** 单步轮询 + 出错自愈（测试用 runOnce 复用） */
  private async step(): Promise<void> {
    let msg: ConversationRecord | undefined;
    try {
      msg = await this.deps.poller.poll();
    } catch (err) {
      this.deps.onError?.(err as Error);
      await this.deps.client.ensureAlive(); // 登录态失效自愈
      return;
    }
    if (!msg) return;
    const { hit, payload } = matchTrigger(msg.text, this.deps.triggerWords);
    if (!hit) return;
    this.enqueue(() => this.handle(payload));
  }

  /** 处理积压消息直至队列为空（测试钩子） */
  async runOnce(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const before = this.pendingCount;
      await this.step();
      if (this.pendingCount === 0 && before === 0) break;
      await this.queue;
    }
    await this.queue;
  }

  private pendingCount = 0;

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
```

- [ ] **Step 4: 运行测试确认通过，提交**

Run: `npx vitest run tests/speaker.test.ts && npm run typecheck`
Expected: 4 passed

```bash
git add -A && git commit -m "feat: Speaker 主循环（串行队列+盲发打断+自愈）"
```

---

### Task 11: 应用装配 + 运行手册

**Files:**
- Create: `src/app.ts`
- Modify: `.env.example`（补全注释）
- Create: `README.md`
- Test: 手动联调清单（无自动化测试——纯装配层，依赖真实服务）

**Interfaces:**
- Consumes: 全部前序任务的产出
- Produces: `npm run dev` / `npm start` 可启动的完整服务

- [ ] **Step 1: 实现装配层**

`src/app.ts`:

```ts
import { loadConfig } from "./config.js";
import { MiClient } from "./mi/client.js";
import { MiDeviceService } from "./mi/devices.js";
import { ConversationPoller } from "./mi/poller.js";
import { SpeakerLoop } from "./mi/speaker.js";
import { Agent } from "./agent/agent.js";
import { OpenAICompatLLM } from "./agent/llm.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { DeviceCache } from "./deviceCache.js";

async function main() {
  const config = loadConfig(process.env);
  console.log("[app] 配置加载完成，正在登录小米云...");

  const client = new MiClient(config);
  await client.init();
  console.log("[app] 小米云登录成功");

  const devices = new MiDeviceService({ client });
  const cache = new DeviceCache({
    remote: devices,
    refreshMs: config.deviceRefreshMs,
    onRefreshError: (e) => console.error("[cache] 刷新失败（保留旧快照）:", e.message),
  });
  await cache.refresh(); // 启动前先建快照
  cache.start();

  const agent = new Agent({
    llm: new OpenAICompatLLM({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      timeoutMs: config.llmTimeoutMs,
    }),
    devices,
    systemPrompt: () => buildSystemPrompt(cache.snapshot()),
  });

  const poller = new ConversationPoller((limit) => client.getLatestRecords(limit));
  const loop = new SpeakerLoop({
    poller,
    agent,
    client,
    triggerWords: config.triggerWords,
    pollIntervalMs: config.pollIntervalMs,
    onError: (e) => console.error("[speaker]", e.message),
  });

  console.log(`[app] 服务已启动：触发词 [${config.triggerWords.join("、") || "全接管"}]`);
  process.on("SIGINT", () => {
    loop.stop();
    cache.stop();
    process.exit(0);
  });
  await loop.start();
}

main().catch((err) => {
  console.error("[app] 启动失败:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 补全 `.env.example` 注释**

```
# 小米账号（MI_USER_ID 是小米 ID 数字，不是手机号；MI_DID 是 AI 入口音箱的设备 ID，
# 可用 https://mi-gpt.idootop.com 在线工具或登录 https://iot.mi.com 从设备列表获取）
MI_USER_ID=
MI_PASSWORD=
MI_DID=

# 小爱音箱 Art (L09A) 的指令；若换 LX01 mini 改为 5,1 / 5,2
TTS_COMMAND=3,1
WAKEUP_COMMAND=3,2

# 轮询间隔（毫秒），最低建议 1000
POLL_INTERVAL_MS=1000

# 触发词：以这些词开头的消息才进 LLM；留空 = 全接管（所有对话都进 LLM）
TRIGGER_WORDS=请,小智

# LLM（任意 OpenAI 兼容端点）
# 智谱 GLM:  https://open.bigmodel.cn/api/paas/v4   模型如 glm-4-plus
# DeepSeek:   https://api.deepseek.com               模型如 deepseek-chat
# Kimi:       https://api.moonshot.cn/v1             模型如 moonshot-v1-8k
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=30000

# 设备快照刷新间隔（毫秒）
DEVICE_REFRESH_MS=30000
```

- [ ] **Step 3: 写 README 运行手册**

`README.md`:

````markdown
# home-agentic-ai

把小爱音箱的"大脑"换成自己订阅的大模型：轮询小爱对话 → LLM 意图理解（Function Calling）→ 米家设备控制 → 小爱原生 TTS 播报。

设计文档：`docs/superpowers/specs/2026-09-01-xiaomi-speaker-custom-llm-design.md`

## 前置条件

- Node.js >= 20
- 小米账号（与米家 App 同一账号，音箱和设备都已绑定）
- 任意 OpenAI 兼容大模型 API Key（GLM / DeepSeek / Kimi / Qwen 等）
- AI 入口音箱默认按 **小爱音箱 Art (L09A)** 配置；其他型号改 `.env` 里的 `TTS_COMMAND` / `WAKEUP_COMMAND`（查 https://home.miot-spec.com）

## 获取 MI_DID

1. 浏览器登录 https://iot.mi.com（与米家同账号）
2. F12 打开控制台 → Network 标签 → 刷新页面
3. 找 `device_list` 请求，响应里找你的音箱条目，`did` 字段即 `MI_DID`
4. `MI_USER_ID` 用小米 ID（数字），在 https://account.xiaomi.com 个人信息页查看

## 运行

```bash
npm install
cp .env.example .env   # 填入配置
npm run dev            # 开发（改动自动重启）
# 或 npm start
```

## 验证（M1→M2→M3 联调清单）

1. **M1 接入层**：启动后对 Art 说"请你好"——日志应出现 `🔥 请你好`，音箱播报 LLM 的回复
2. **M2 设备控制**：对 Art 说"请打开台灯"——台灯应真实打开并播报结果（先拿不重要的灯试！）
3. **M3 意图理解**：说"请我要睡了"——应组合关闭灯/空调；说"请有点冷"——应调高空调温度
4. **兜底**：断开 LLM Key 再说话——应播报"我脑子转不动了"

## 注意

- 依赖小米云非官方接口，登录态可能数周失效一次：报错后重启服务重新登录即可
- 触发词默认"请 / 小智"开头；`TRIGGER_WORDS=` 留空进入全接管实验模式
- 免责：仅供个人学习研究，异常调用有被小米风控的理论风险（自用低频风险低）
````

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 应用装配与运行手册（M1-M3 联调清单）"
```

---

### Task 12: 真机联调（手动验证，需用户配合）

**Files:**
- Modify: 无代码（发现问题则回到对应 Task 修复）

**Interfaces:**
- Consumes: Task 11 的运行手册
- Produces: 真机验证通过的服务

- [ ] **Step 1: M1 验证——接入层**

用户填好 `.env` 后运行 `npm run dev`，对 Art 音箱说"请你好"。
通过标准：日志出现 `🔥 请你好`，音箱播报 LLM 回复。
常见失败排查：`MI_USER_ID` 填成手机号（应为数字小米 ID）；`MI_DID` 填错设备；异地登录触发风控（换用常用网络重试）。

- [ ] **Step 2: M2 验证——设备控制**

对 Art 说"请打开台灯"（**先选不重要的灯**）。
通过标准：台灯真实开关 + 播报执行结果。若设备无反应但播报成功，检查该设备在米家 App 是否云端可控（蓝牙网关-only 设备不支持云控制）。

- [ ] **Step 3: M3 验证——意图理解与兜底**

依次说："请我要睡了"（组合关灯关空调）、"请有点冷"（调温）、随便闲聊一句。
再使 LLM Key 失效说一句话验证兜底话术。
通过标准：模糊意图被正确组合执行；LLM 故障时播报兜底话术且服务不崩。

- [ ] **Step 4: 修复发现的问题并提交**

每个问题回到对应模块修复（附失败现象），修复后重跑 `npm test`。

```bash
git add -A && git commit -m "fix: 真机联调问题修复"
```

---

## Self-Review 记录

- **Spec 覆盖**：架构三模块（Task 4/6/9/10）、口令触发（Task 2）、双通道 TTS——v1 实现原生通道，第三方 TTS 为 spec 中的"扩展点"（预留 `MiClient.speak` 单点改造位，不建空文件）；设备缓存（Task 7）；异常处理四类（Task 9 兜底/Task 6 自纠/Task 10 自愈）；M1-M3 里程碑（Task 11/12）
- **类型一致性**：`ConversationRecord`/`DeviceInfo`/`IRemoteDevice` 在 Task 1 定义，Task 3-10 一致引用；`MiDeviceService` 实现 `IRemoteDevice` 且附加 `resolveDevice`，Agent 依赖类型为此扩展接口，已在 Task 9 Interfaces 块注明
- **占位符扫描**：无 TBD/TODO；每个代码步骤给出完整可运行代码
