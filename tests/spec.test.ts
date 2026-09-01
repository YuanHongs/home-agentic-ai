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
