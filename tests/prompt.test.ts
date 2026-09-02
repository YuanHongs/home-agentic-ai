import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import type { DeviceInfo } from "../src/types.js";

const devices: DeviceInfo[] = [
  {
    did: "did.light",
    name: "客厅主灯",
    model: "philips.light.bulb",
    capabilities: [
      { kind: "property", siid: 2, piid: 1, name: "Switch Status", desc: "开关", format: "bool", access: ["read", "write"] },
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
