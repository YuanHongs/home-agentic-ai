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

  it("DEVICE_DENYLIST 默认排除音箱自身（防语音关掉 AI 入口）", () => {
    const c = loadConfig(validEnv);
    expect(c.deviceDenylist).toEqual(["xiaomi.wifispeaker"]);
  });

  it("DEVICE_DENYLIST 逗号分隔解析为列表并去空白", () => {
    const c = loadConfig({ ...validEnv, DEVICE_DENYLIST: "大门门锁, philips.light.bulb" });
    expect(c.deviceDenylist).toEqual(["大门门锁", "philips.light.bulb"]);
  });

  it("DEVICE_TYPE_ALLOWLIST 默认为安全可控设备类型集合", () => {
    const c = loadConfig(validEnv);
    expect(c.deviceTypeAllowlist).toContain("light");
    expect(c.deviceTypeAllowlist).toContain("air-conditioner");
    expect(c.deviceTypeAllowlist).toContain("bath-heater");
    expect(c.deviceTypeAllowlist).toContain("fresh-air-system");
    // 高危类型默认不放行
    expect(c.deviceTypeAllowlist).not.toContain("lock");
    expect(c.deviceTypeAllowlist).not.toContain("camera");
    expect(c.deviceTypeAllowlist).not.toContain("gateway");
  });

  it("DEVICE_TYPE_ALLOWLIST 自定义逗号分隔解析为列表并去空白（小写归一）", () => {
    const c = loadConfig({ ...validEnv, DEVICE_TYPE_ALLOWLIST: "Light, lock ,," });
    expect(c.deviceTypeAllowlist).toEqual(["light", "lock"]);
  });

  it("POLL_INTERVAL_MS 低于 500ms 时抛错并提示最低值", () => {
    expect(() => loadConfig({ ...validEnv, POLL_INTERVAL_MS: "100" })).toThrow(
      /最低 500ms/,
    );
  });
});
