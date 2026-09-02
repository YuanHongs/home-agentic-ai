import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetInstancesCacheForTest,
  fetchSpec,
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
  it("model 首段 vendor + 末段尾缀映射 URN 第5段（type 词不参与匹配）", () => {
    // model 中段 wifispeaker 与 URN 的 type=speaker 不对应，匹配只看 xiaomi-l09a
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
    expect(await fetchSpec("xiaomi.wifispeaker.unknown", httpGet)).toBeUndefined();
    expect(urls).toEqual(["https://miot-spec.org/miot-spec-v2/instances"]); // 只拉了列表
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
});
