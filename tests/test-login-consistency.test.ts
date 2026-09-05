import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * test-login.mjs 是零依赖独立脚本（不 import TS），风控识别的 marker 与
 * URL 前缀与 src/mi/client.ts 硬编码重复——本测试锁住两者一致，src 改字面量
 * 而脚本没跟随时这里先红。
 */
describe("test-login.mjs 与 src 风控识别一致性", () => {
  const script = readFileSync(new URL("../test-login.mjs", import.meta.url), "utf-8");
  const clientSrc = readFileSync(new URL("../src/mi/client.ts", import.meta.url), "utf-8");

  it("风控 marker 字面量一致", () => {
    expect(script).toContain('"异地登录安全验证"');
    expect(clientSrc).toContain('"异地登录安全验证"');
  });

  it("授权链接前缀字面量一致", () => {
    expect(script).toContain('"https://account.xiaomi.com/"');
    expect(clientSrc).toContain('"https://account.xiaomi.com/"');
  });
});
