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
