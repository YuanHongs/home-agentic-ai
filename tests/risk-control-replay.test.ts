import { describe, expect, it } from "vitest";
import { detectRiskControl, MiRiskControlError } from "../src/mi/client.js";
import {
  WIN_XIAOMIIO_LOG,
  NORMAL_FAIL_LOG,
  WIN_MICOAPI_LOG,
} from "./fixtures/risk-control-real-logs.js";

/**
 * 真实日志回放：样本来自 2026-09-05 真机联调触发的风控终端输出（截图 OCR 还原），
 * 是 mi-service-lite 风控分支的真实文案与格式——锁住识别逻辑对真实世界的契约。
 * 小米改文案/库改输出时这里最先红。
 */
describe("风控识别·真实日志回放", () => {
  it("Windows 首次触发（xiaomiio 域，链接被终端折行）：识别为风控并提取授权链接", () => {
    const r = detectRiskControl(WIN_XIAOMIIO_LOG);
    expect(r).toBeDefined();
    expect(r!.authUrl).toBeDefined();
    expect(r!.authUrl!.startsWith("https://account.xiaomi.com/")).toBe(true);
    // 提取的是完整 URL 的可识别首段（折行后的第一段以 👉 前缀行开头），
    // 且是 xiaomiio 域的链接
    expect(r!.authUrl!).toContain("sid=xiaomiio");
  });

  it("Windows 授权后重试仍触发（micoapi 域——两个域需分别授权）：同样识别且链接域正确", () => {
    const r = detectRiskControl(WIN_MICOAPI_LOG);
    expect(r).toBeDefined();
    expect(r!.authUrl!).toContain("sid=micoapi");
  });

  it("正常登录失败（凭证错误，无风控文案）：不误判为风控", () => {
    expect(detectRiskControl(NORMAL_FAIL_LOG)).toBeUndefined();
  });

  it("MiRiskControlError 的用户指引包含关键操作信息（两域授权/等1小时/勿重试）", () => {
    const err = new MiRiskControlError("https://account.xiaomi.com/xxx");
    expect(err.name).toBe("MiRiskControlError");
    expect(err.authUrl).toBe("https://account.xiaomi.com/xxx");
    expect(err.message).toContain("xiaomiio");
    expect(err.message).toContain("micoapi");
    expect(err.message).toContain("1 小时");
    expect(err.message).toContain("勿反复重试");
  });
});
