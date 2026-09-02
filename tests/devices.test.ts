import { describe, expect, it, vi, type Mock } from "vitest";
import { MiDeviceService } from "../src/mi/devices.js";
import type { MiClient } from "../src/mi/client.js";

interface MockClient {
  listRawDevices: Mock;
  specGet: Mock;
  specSet: Mock;
  specAction: Mock;
}

/** 真实 spec 形状：iid 字段 + 英文 description + 中文 comment */
const lightSpec = {
  services: [
    {
      iid: 2,
      description: "Bulb",
      properties: [
        { iid: 1, description: "Switch Status", comment: "开关", format: "bool", access: ["read", "write"] },
      ],
      actions: [],
    },
  ],
};

const makeClient = (): MockClient => ({
  listRawDevices: vi.fn(async () => [
    { did: "did.light", name: "客厅主灯", model: "philips.light.bulb" },
    { did: "did.ac", name: "卧室空调", model: "fake.ac" },
  ]),
  specGet: vi.fn(async () => [{ code: 0, did: "did.light", siid: 2, piid: 1, value: true }]),
  specSet: vi.fn(async () => true),
  specAction: vi.fn(async () => true),
} as unknown as MockClient);

const makeService = (client: MockClient = makeClient()) =>
  new MiDeviceService({
    client: client as unknown as MiClient,
    fetchSpecJson: async (model) =>
      model === "philips.light.bulb" ? lightSpec : { services: [] },
  });

/** 目录含两盏同名后缀主灯，用于验证模糊匹配的歧义消解 */
const makeTwoLightsClient = (): MockClient => ({
  ...makeClient(),
  listRawDevices: vi.fn(async () => [
    { did: "did.light1", name: "客厅主灯", model: "fake.light" },
    { did: "did.light2", name: "卧室主灯", model: "fake.light" },
  ]),
} as unknown as MockClient);

/** 目录含两台空调，用于验证 substring 层歧义防御 */
const makeTwoAcClient = (): MockClient => ({
  ...makeClient(),
  listRawDevices: vi.fn(async () => [
    { did: "did.ac1", name: "客厅空调", model: "fake.ac" },
    { did: "did.ac2", name: "卧室空调", model: "fake.ac" },
  ]),
} as unknown as MockClient);

describe("MiDeviceService", () => {
  it("listDevices 合并设备列表与 spec 能力", async () => {
    const svc = makeService();
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(2);
    const light = devices.find((d) => d.did === "did.light")!;
    expect(light.name).toBe("客厅主灯");
    expect(light.capabilities).toHaveLength(1);
    expect(light.capabilities[0]).toMatchObject({ name: "Switch Status", desc: "开关", piid: 1 });
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

  it("resolveDevice 模糊匹配取全局最优（'客厅的灯' 在两盏主灯中唯一命中客厅主灯）", async () => {
    const svc = makeService(makeTwoLightsClient());
    const d = await svc.resolveDevice("客厅的灯");
    expect(d?.did).toBe("did.light1");
  });

  it("resolveDevice 模糊匹配并列最优时返回 undefined（'卧室的主灯' 两灯并列，供 LLM 自纠）", async () => {
    const svc = makeService(makeTwoLightsClient());
    expect(await svc.resolveDevice("卧室的主灯")).toBeUndefined();
  });

  it("resolveDevice 空串/纯空白返回 undefined（LLM 缺 device 参数时不命中第一台设备）", async () => {
    const svc = makeService();
    expect(await svc.resolveDevice("")).toBeUndefined();
    expect(await svc.resolveDevice("  ")).toBeUndefined();
  });

  it("resolveDevice substring 层唯一命中返回该设备（'打开客厅主灯' 包含设备名）", async () => {
    const svc = makeService();
    expect((await svc.resolveDevice("打开客厅主灯"))?.did).toBe("did.light");
  });

  it("resolveDevice substring 层多命中返回 undefined（两台空调查'空调'不猜，供 LLM 澄清）", async () => {
    const svc = makeService(makeTwoAcClient());
    expect(await svc.resolveDevice("空调")).toBeUndefined();
  });

  it("executeAction 对 property 能力走 specSet", async () => {
    const client = makeClient();
    const svc = makeService(client);
    const r = await svc.executeAction("did.light", "Switch Status", false);
    expect(r.ok).toBe(true);
    expect(client.specSet).toHaveBeenCalledWith("did.light", 2, 1, false);
  });

  it("executeAction 对未知能力返回失败并列出可用能力（供 LLM 自纠）", async () => {
    const svc = makeService();
    const r = await svc.executeAction("did.light", "Brightness", 80);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Switch Status");
  });

  it("executeAction 对不存在的设备返回失败并列出设备名单", async () => {
    const svc = makeService();
    const r = await svc.executeAction("did.ghost", "Switch Status", true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("客厅主灯");
    expect(r.message).toContain("卧室空调");
  });

  it("getDeviceState 返回能力名->值映射", async () => {
    const svc = makeService();
    const state = await svc.getDeviceState("did.light");
    expect(state).toEqual({ did: "did.light", properties: { "Switch Status": true } });
  });

  it("getDeviceState specGet 返回 undefined 时不抛错，返回空 properties（错误不炸整轮对话）", async () => {
    const client = makeClient();
    client.specGet = vi.fn(async () => undefined);
    const svc = makeService(client);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const state = await svc.getDeviceState("did.light");
      expect(state).toEqual({ did: "did.light", properties: {} });
      expect(errSpy).toHaveBeenCalled(); // 失败可见（记录一行日志）
    } finally {
      errSpy.mockRestore();
    }
  });

  it("refreshMs TTL 生效：TTL 内命中缓存不重拉，过期后重新拉取", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      const svc = new MiDeviceService({
        client: client as unknown as MiClient,
        refreshMs: 30_000,
        fetchSpecJson: async () => ({ services: [] }),
      });
      await svc.listDevices();
      expect(client.listRawDevices).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(29_000); // TTL 内：命中缓存
      await svc.listDevices();
      expect(client.listRawDevices).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000); // TTL 过期：重新拉取
      await svc.listDevices();
      expect(client.listRawDevices).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TTL 过期后重新拉取目录，但已知 model 不再重复拉取 spec", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      const fetchSpecJson = vi.fn(async () => ({ services: [] }));
      const svc = new MiDeviceService({
        client: client as unknown as MiClient,
        refreshMs: 30_000,
        fetchSpecJson,
      });
      await svc.listDevices();
      expect(fetchSpecJson).toHaveBeenCalledTimes(2); // 两个 model 各拉一次

      vi.advanceTimersByTime(31_000); // TTL 过期：目录重拉，spec 复用 capCache
      await svc.listDevices();
      expect(client.listRawDevices).toHaveBeenCalledTimes(2);
      expect(fetchSpecJson).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("新设备加入列表时只对新 model 拉取一次 spec", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      const fetchSpecJson = vi.fn(async () => ({ services: [] }));
      const svc = new MiDeviceService({
        client: client as unknown as MiClient,
        refreshMs: 30_000,
        fetchSpecJson,
      });
      await svc.listDevices();
      expect(fetchSpecJson).toHaveBeenCalledTimes(2);

      client.listRawDevices = vi.fn(async () => [
        { did: "did.light", name: "客厅主灯", model: "philips.light.bulb" },
        { did: "did.ac", name: "卧室空调", model: "fake.ac" },
        { did: "did.new", name: "书房加湿器", model: "fake.humidifier" },
      ]) as unknown as MockClient["listRawDevices"];

      vi.advanceTimersByTime(31_000);
      const devices = await svc.listDevices();
      expect(devices).toHaveLength(3);
      expect(fetchSpecJson).toHaveBeenCalledTimes(3); // 仅新 model fake.humidifier 多拉一次
      expect(fetchSpecJson).toHaveBeenLastCalledWith("fake.humidifier");

      // 再次 TTL 过期重拉：三个 model 均已缓存，spec 零请求
      vi.advanceTimersByTime(31_000);
      await svc.listDevices();
      expect(fetchSpecJson).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spec 瞬时拉取失败不落能力缓存，下轮 TTL 重拉成功后能力恢复", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      let failOnce = true;
      const fetchSpecJson = vi.fn(async (model: string) => {
        if (model === "philips.light.bulb" && failOnce) {
          failOnce = false;
          throw new Error("transient network error");
        }
        return model === "philips.light.bulb" ? lightSpec : { services: [] };
      });
      const svc = new MiDeviceService({
        client: client as unknown as MiClient,
        refreshMs: 30_000,
        fetchSpecJson,
      });
      const first = await svc.listDevices();
      expect(first.find((d) => d.did === "did.light")?.capabilities).toHaveLength(0);

      vi.advanceTimersByTime(31_000);
      const second = await svc.listDevices();
      expect(fetchSpecJson).toHaveBeenCalledTimes(3); // 失败的 model 重试成功
      expect(second.find((d) => d.did === "did.light")?.capabilities).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spec 拉取失败时记录一行带 model 名的日志（失败可见，不阻塞设备列表）", async () => {
    const client = makeClient();
    const svc = new MiDeviceService({
      client: client as unknown as MiClient,
      fetchSpecJson: async (model) => {
        if (model === "philips.light.bulb") throw new Error("spec timeout");
        return { services: [] };
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const devices = await svc.listDevices();
      expect(devices.find((d) => d.did === "did.light")?.capabilities).toHaveLength(0);
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("philips.light.bulb");
    } finally {
      errSpy.mockRestore();
    }
  });
});
