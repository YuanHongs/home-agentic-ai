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
