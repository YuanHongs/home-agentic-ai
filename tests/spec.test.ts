import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetInstancesCacheForTest,
  fetchSpec,
  fetchSpecWithType,
  parseSpec,
  resolveUrn,
} from "../src/mi/spec.js";

const specJson = JSON.parse(
  readFileSync(new URL("./fixtures/spec-light.json", import.meta.url), "utf-8"),
);

const instancesJson = JSON.parse(
  readFileSync(new URL("./fixtures/miot-instances.json", import.meta.url), "utf-8"),
);
const urns: string[] = instancesJson.instances;

describe("resolveUrn", () => {
  it("model 首段 vendor + 末段尾缀映射 URN 第5段（无中段可匹配时 type 词不参与匹配）", () => {
    // 中段 wifispeaker 经双向包含命中 type=speaker（见消歧用例），但即便不匹配，
    // vendor-tail 匹配也独立成立——中段只是候选间的偏好条件，不是硬性门槛
    expect(resolveUrn("xiaomi.wifispeaker.l09a", urns)).toBe(
      "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-l09a:2",
    );
  });

  it("多个版本命中时取版本号最大", () => {
    expect(resolveUrn("philips.light.bulb", urns)).toBe(
      "urn:miot-spec-v2:device:light:0000A00A:philips-bulb:2",
    );
  });

  it("vendor 不匹配的同尾缀 URN 不命中（xiaomi-l09a ≠ roome-l09a）", () => {
    expect(resolveUrn("roome.speaker.l09a", urns)).toBe(
      "urn:miot-spec-v2:device:speaker:0000A015:roome-l09a:5",
    );
  });

  it("无匹配返回 undefined", () => {
    expect(resolveUrn("xiaomi.wifispeaker.unknown", urns)).toBeUndefined();
  });

  it("8 段 URN（BLE-mesh 网关子设备，尾部 service hash）能命中且返回完整 URN", () => {
    // 11,807 个 vendor-tail 只以 8 段形式存在（如 yeelink-meshbulb2）
    expect(resolveUrn("yeelink.light.meshbulb2", urns)).toBe(
      "urn:miot-spec-v2:device:light:0000A001:yeelink-meshbulb2:1:0000C802",
    );
  });

  it("同 vendor-tail 同时有 7 段与 8 段：版本号最大者优先", () => {
    // 7 段 v3 vs 8 段 v2 → 取版本号最大的 7 段 v3
    expect(resolveUrn("philips.light.bulb3", urns)).toBe(
      "urn:miot-spec-v2:device:light:0000A00C:philips-bulb3:3",
    );
  });

  it("同 vendor-tail 同版本时取 7 段（8 段是 mesh 子设备变体，共存时多为不同设备类型）", () => {
    // 7 段 v2 vs 8 段 v2 → 取 7 段。复审实测（2026-09-02）：同 vendor-tail 共存
    // 同版本的 7 段与 8 段 URN 几乎全是不同设备类型（如 7 段 Light / 8 段 Switch），
    // 并非"同一设备的两种编码"，故优先取主体设备的 7 段形式。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUrn("philips.light.bulb2", urns)).toBe(
        "urn:miot-spec-v2:device:light:0000A00B:philips-bulb2:2",
      );
      // 同版本多候选（多段数/多类型）是歧义场景：打一行日志让这类设备可观测，
      // 并带上选中 URN 的 device type 段（seg[3]），让"猜的是哪个类型"可判断
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[spec] vendor-tail %s 同版本 %s 存在 %d 个候选 URN（多段数/多类型共存，可能为不同设备），按 7 段优先取 %s（device type: %s）",
        "philips-bulb2",
        2,
        2,
        "urn:miot-spec-v2:device:light:0000A00B:philips-bulb2:2",
        "light",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("同版本仅 8 段多类型 tie 且中段无匹配：照常命中 8 段并打歧义日志", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const list = [
        "urn:miot-spec-v2:device:light:0000A001:fake-mesh:1:0000C802",
        "urn:miot-spec-v2:device:switch:0000A001:fake-mesh:1:0000C803",
      ];
      // 中段 "unknown" 不命中任何候选 type → 回退现有行为（版本最大→7 段优先→首个）
      expect(resolveUrn("fake.unknown.mesh", list)).toBe(
        "urn:miot-spec-v2:device:light:0000A001:fake-mesh:1:0000C802",
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("同版本多类型 tie 但中段命中：消歧选中匹配类型、无歧义日志", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const list = [
        "urn:miot-spec-v2:device:light:0000A001:fake-mesh:1:0000C802",
        "urn:miot-spec-v2:device:switch:0000A001:fake-mesh:1:0000C803",
      ];
      // 中段 "light" 精确命中 light 候选：不再依赖"7 段优先/首个"的盲选
      expect(resolveUrn("fake.light.mesh", list)).toBe(
        "urn:miot-spec-v2:device:light:0000A001:fake-mesh:1:0000C802",
      );
      // 消歧生效（2 个候选缩窄为 1 个）应可观测；消歧后唯一候选，
      // 不再打"同版本多候选"的歧义日志
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("消歧"),
        "fake.light.mesh",
        "light",
        2,
        1,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("中段词消歧：viomi.vacuum.v8 有 9 个不同类型 URN，中段 vacuum 命中 vacuum 而非 max-version 的 hood", () => {
    // CR4 正确性波：真实场景（miot-spec.org 实测）viomi.vacuum.v8 挂着 9 个
    // 不同设备类型的 URN（vendor-tail 为 viomi-v8），hood v2 是全局最大版本
    // ——纯 max-version 会选中错误类型的 hood spec；model 中段 "vacuum" 与
    // URN type 段精确匹配，应在 vacuum 候选内再按现有规则选择
    const viomiUrns = [
      "urn:miot-spec-v2:device:vacuum:0000A006:viomi-v8:1",
      "urn:miot-spec-v2:device:hood:0000A01B:viomi-v8:1",
      "urn:miot-spec-v2:device:hood:0000A01B:viomi-v8:2", // 全局最大版本，错误类型
      "urn:miot-spec-v2:device:bath-heater:0000A028:viomi-v8:1",
      "urn:miot-spec-v2:device:integrated-stove:0000A056:viomi-v8:1",
      "urn:miot-spec-v2:device:fan:0000A005:viomi-v8:1",
      "urn:miot-spec-v2:device:heater:0000A01A:viomi-v8:1",
      "urn:miot-spec-v2:device:washer:0000A01F:viomi-v8:1",
      "urn:miot-spec-v2:device:air-conditioner:0000A004:viomi-v8:1",
    ];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUrn("viomi.vacuum.v8", viomiUrns)).toBe(
        "urn:miot-spec-v2:device:vacuum:0000A006:viomi-v8:1",
      );
      // 消歧生效（9 个候选缩窄为 1 个）应可观测
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("消歧"),
        "viomi.vacuum.v8",
        "vacuum",
        9,
        1,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("中段无匹配时回退现有行为：全候选按版本最大选择", () => {
    // 中段 "foo" 不命中任何候选 type（light），回退到 vendor-tail + max-version
    expect(resolveUrn("philips.foo.bulb", urns)).toBe(
      "urn:miot-spec-v2:device:light:0000A00A:philips-bulb:2",
    );
  });

  it("中段与 type 双向包含可命中：wifispeaker ⊃ speaker，解析结果不受消歧影响", () => {
    // xiaomi.wifispeaker.l09a 的中段 "wifispeaker" 包含 type "speaker"——
    // "相等"语义会漏掉这种复合词；双向包含命中后候选集不变（本就只有 speaker），
    // 结果与不消歧一致
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUrn("xiaomi.wifispeaker.l09a", urns)).toBe(
        "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-l09a:2",
      );
      // 候选集未被缩窄（两个候选都是 speaker）：不打消歧日志
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("唯一候选（无论 7/8 段）不打歧义日志", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUrn("xiaomi.wifispeaker.l09a", urns)).toBeDefined();
      expect(resolveUrn("yeelink.light.meshbulb2", urns)).toBeDefined();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("fetchSpec", () => {
  beforeEach(() => {
    // 进程内 instances 缓存跨测试隔离
    _resetInstancesCacheForTest();
  });

  it("两级拉取：先 instances 列表，再按解析出的 URN 拉 instance", async () => {
    const urls: string[] = [];
    const httpGet = async (url: string): Promise<unknown> => {
      urls.push(url);
      if (url.endsWith("/instances")) return instancesJson;
      return specJson;
    };
    const spec = await fetchSpec("xiaomi.wifispeaker.l09a", httpGet);
    expect(urls).toEqual([
      "https://miot-spec.org/miot-spec-v2/instances",
      "https://miot-spec.org/miot-spec-v2/instance?type=urn%3Amiot-spec-v2%3Adevice%3Aspeaker%3A0000A015%3Axiaomi-l09a%3A2",
    ]);
    expect(spec).toEqual(specJson);
  });

  it("URN 解析不到时返回 undefined（不抛错，上层按无能力处理）", async () => {
    const urls: string[] = [];
    const httpGet = async (url: string): Promise<unknown> => {
      urls.push(url);
      return instancesJson;
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await fetchSpec("xiaomi.wifispeaker.unknown", httpGet)).toBeUndefined();
      expect(urls).toEqual(["https://miot-spec.org/miot-spec-v2/instances"]); // 只拉了列表
      // undefined 返回路径可观测：console.error 打一行日志（不会被上层 catch 吞掉）
      expect(errorSpy).toHaveBeenCalledWith(
        "[spec] 未找到型号 %s 的 MIoT spec（该设备暂无精细控制能力）",
        "xiaomi.wifispeaker.unknown",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("8 段 URN 命中：fetchSpec 用完整 URN（含尾部 service hash）拉 instance", async () => {
    const urls: string[] = [];
    const httpGet = async (url: string): Promise<unknown> => {
      urls.push(url);
      if (url.endsWith("/instances")) return instancesJson;
      return specJson;
    };
    const spec = await fetchSpec("yeelink.light.meshbulb2", httpGet);
    expect(urls).toEqual([
      "https://miot-spec.org/miot-spec-v2/instances",
      "https://miot-spec.org/miot-spec-v2/instance?type=urn%3Amiot-spec-v2%3Adevice%3Alight%3A0000A001%3Ayeelink-meshbulb2%3A1%3A0000C802",
    ]);
    expect(spec).toEqual(specJson);
  });

  it("instances 列表进程内缓存：多次调用不重复拉列表", async () => {
    const httpGet = vi.fn(async (url: string): Promise<unknown> =>
      url.endsWith("/instances") ? instancesJson : specJson,
    );
    await fetchSpec("xiaomi.wifispeaker.l09a", httpGet);
    await fetchSpec("philips.light.bulb", httpGet);
    const listFetches = httpGet.mock.calls.filter(([u]) => u.endsWith("/instances"));
    expect(listFetches).toHaveLength(1); // 列表只拉一次
    expect(httpGet).toHaveBeenCalledTimes(3); // 列表 1 次 + 两个 instance 各 1 次
  });
});

describe("fetchSpecWithType", () => {
  beforeEach(() => {
    _resetInstancesCacheForTest();
  });

  it("返回 spec json 与 URN 第 4 段的 device type（speaker）", async () => {
    const httpGet = async (url: string): Promise<unknown> =>
      url.endsWith("/instances") ? instancesJson : specJson;
    const r = await fetchSpecWithType("xiaomi.wifispeaker.l09a", httpGet);
    expect(r).toEqual({ json: specJson, deviceType: "speaker" });
  });

  it("light 型号解析出 deviceType=light", async () => {
    const httpGet = async (url: string): Promise<unknown> =>
      url.endsWith("/instances") ? instancesJson : specJson;
    const r = await fetchSpecWithType("philips.light.bulb", httpGet);
    expect(r?.deviceType).toBe("light");
  });

  it("URN 解析不到时返回 undefined（与 fetchSpec 一致，不抛错）", async () => {
    const httpGet = async (url: string): Promise<unknown> => instancesJson;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await fetchSpecWithType("xiaomi.wifispeaker.unknown", httpGet)).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fetchSpec 保持向后兼容：返回 fetchSpecWithType 的 json 部分", async () => {
    const httpGet = async (url: string): Promise<unknown> =>
      url.endsWith("/instances") ? instancesJson : specJson;
    expect(await fetchSpec("philips.light.bulb", httpGet)).toEqual(specJson);
  });
});

describe("parseSpec", () => {
  it("提取可写属性与动作，只读属性排除", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    const names = caps.map((c) => c.name);
    expect(names).toContain("Switch Status");
    expect(names).toContain("Brightness");
    expect(names).not.toContain("Uptime"); // 只读，排除
    expect(names).toContain("Toggle");
  });

  it("字段取自真实 spec 形状：iid 即 siid/piid，desc 优先取中文 comment", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    const on = caps.find((c) => c.name === "Switch Status")!;
    expect(on).toMatchObject({
      kind: "property",
      siid: 2,
      piid: 1,
      format: "bool",
      desc: "开关", // description 是英文 "Switch Status"，desc 取 comment 中文
    });
    const brightness = caps.find((c) => c.name === "Brightness")!;
    expect(brightness.desc).toBe("亮度");
  });

  it("无 comment 时回退 ZH 映射表，再回退英文 description 原文", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    // Color Temperature 无 comment → ZH 映射表命中
    expect(caps.find((c) => c.name === "Color Temperature")?.desc).toBe("色温");
  });

  it("未知能力名保留英文原名作 desc，动作带 siid/aiid（iid）", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    const toggle = caps.find((c) => c.name === "Toggle")!;
    expect(toggle).toMatchObject({ kind: "action", siid: 2, aiid: 1, desc: "Toggle" });
  });

  it("description 为空的 property/action 直接跳过（真实 spec 存在大量只有 comment 的字段，不能产出空名能力）", () => {
    const caps = parseSpec("fake.light.empty", {
      services: [
        {
          iid: 2,
          description: "Bulb",
          properties: [
            { iid: 1, description: "", comment: "空名属性", format: "bool", access: ["write"] },
            { iid: 2, description: "On", format: "bool", access: ["write"] },
          ],
          actions: [{ iid: 1, description: "" }, { iid: 2, description: "Toggle" }],
        },
      ],
    });
    expect(caps.map((c) => c.name)).toEqual(["On", "Toggle"]);
    expect(caps.some((c) => c.name === "")).toBe(false);
  });

  it("value-range [min,max,step] 解析为 constraint（取前两段，step 丢弃）", () => {
    const caps = parseSpec("fake.light.range", {
      services: [
        {
          iid: 2,
          description: "Bulb",
          properties: [
            { iid: 1, description: "Brightness", format: "uint8", access: ["write"], "value-range": [1, 100, 1] },
          ],
        },
      ],
    });
    expect(caps[0].constraint).toEqual({ min: 1, max: 100 });
  });

  it("value-range 非法形状（非数组/长度不足/非数值）不产出 constraint", () => {
    const caps = parseSpec("fake.light.badrange", {
      services: [
        {
          iid: 2,
          description: "Bulb",
          properties: [
            { iid: 1, description: "A", format: "uint8", access: ["write"], "value-range": "1-100" },
            { iid: 2, description: "B", format: "uint8", access: ["write"], "value-range": [1] },
            { iid: 3, description: "C", format: "uint8", access: ["write"], "value-range": ["a", "b"] },
          ],
        },
      ],
    });
    expect(caps.every((c) => c.constraint === undefined)).toBe(true);
  });

  it("value-list 解析为 values（取每项的 value 字段）", () => {
    const caps = parseSpec("fake.light.list", {
      services: [
        {
          iid: 2,
          description: "Bulb",
          properties: [
            {
              iid: 1,
              description: "Mode",
              format: "uint8",
              access: ["write"],
              "value-list": [
                { value: 1, description: "低" },
                { value: 2, description: "高" },
              ],
            },
          ],
        },
      ],
    });
    expect(caps[0].values).toEqual([1, 2]);
  });

  it("fixture 的 Brightness 解析出 value-range 约束（真实 spec 形状回归）", () => {
    const caps = parseSpec("philips.light.bulb", specJson);
    expect(caps.find((c) => c.name === "Brightness")?.constraint).toEqual({ min: 1, max: 100 });
  });
});
