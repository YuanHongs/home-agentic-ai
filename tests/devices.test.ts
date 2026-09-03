import { describe, expect, it, vi, type Mock } from "vitest";
import { MiDeviceService } from "../src/mi/devices.js";
import type { MiClient } from "../src/mi/client.js";
import type { SpecWithType } from "../src/mi/spec.js";

/** spec 注入统一形状：{json, deviceType} */
const specOf = (json: unknown, deviceType: string): SpecWithType => ({ json, deviceType });

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
      model === "philips.light.bulb"
        ? specOf(lightSpec, "light")
        : specOf({ services: [] }, "air-conditioner"),
  });

/** 门锁 spec：含高危动作 Unlock/FactoryReset 与普通属性 On */
const lockSpec = {
  services: [
    {
      iid: 4,
      description: "Lock",
      properties: [
        { iid: 1, description: "On", comment: "开关", format: "bool", access: ["read", "write"] },
      ],
      actions: [
        { iid: 1, description: "Unlock" },
        { iid: 2, description: "FactoryReset" },
      ],
    },
  ],
};

/** 目录含一把门锁，用于验证高危动作过滤 */
const makeLockClient = (): MockClient => ({
  ...makeClient(),
  listRawDevices: vi.fn(async () => [
    { did: "did.lock", name: "大门门锁", model: "fake.lock" },
  ]),
} as unknown as MockClient);

const makeLockService = (client: MockClient = makeLockClient()) =>
  new MiDeviceService({
    client: client as unknown as MiClient,
    fetchSpecJson: async () => specOf(lockSpec, "lock"),
  });

/**
 * 白名单类型（light）但 spec 混入危险动作名：验证正则第二道防线
 * （S6——主防线是类型白名单，此设备模拟"白名单设备的 spec 里混入危险动作"）
 */
const dangerSpec = {
  services: [
    {
      iid: 2,
      description: "Bulb",
      properties: [
        { iid: 1, description: "On", comment: "开关", format: "bool", access: ["read", "write"] },
      ],
      actions: [
        { iid: 1, description: "Format" },
        { iid: 2, description: "Add Lock User" },
        { iid: 3, description: "Silence" },
        { iid: 4, description: "Send Data" },
        { iid: 5, description: "Unlock" },
        { iid: 6, description: "FactoryReset" },
      ],
    },
  ],
};

const makeDangerClient = (): MockClient => ({
  ...makeClient(),
  listRawDevices: vi.fn(async () => [
    { did: "did.danger", name: "客厅灯", model: "fake.light.danger" },
  ]),
} as unknown as MockClient);

const makeDangerService = (client: MockClient = makeDangerClient()) =>
  new MiDeviceService({
    client: client as unknown as MiClient,
    fetchSpecJson: async () => specOf(dangerSpec, "light"),
  });

/** 多格式能力 spec：bool / uint8+range / string / action，用于值校验测试（S3） */
const typedSpec = {
  services: [
    {
      iid: 2,
      description: "Bulb",
      properties: [
        { iid: 1, description: "Switch Status", comment: "开关", format: "bool", access: ["write"] },
        { iid: 2, description: "Brightness", comment: "亮度", format: "uint8", access: ["write"], "value-range": [1, 100, 1] },
        { iid: 3, description: "Name", comment: "名称", format: "string", access: ["write"] },
      ],
      actions: [{ iid: 1, description: "Blink" }],
    },
  ],
};

const makeTypedClient = (): MockClient => ({
  ...makeClient(),
  listRawDevices: vi.fn(async () => [
    { did: "did.typed", name: "客厅灯", model: "fake.light.typed" },
  ]),
} as unknown as MockClient);

const makeTypedService = (client: MockClient = makeTypedClient()) =>
  new MiDeviceService({
    client: client as unknown as MiClient,
    fetchSpecJson: async () => specOf(typedSpec, "light"),
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
  it("listDevices 合并设备列表与 spec 能力（含 deviceType）", async () => {
    const svc = makeService();
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(2);
    const light = devices.find((d) => d.did === "did.light")!;
    expect(light.name).toBe("客厅主灯");
    expect(light.deviceType).toBe("light");
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

  it("executeAction 拒绝高危动作名（Unlock/FactoryReset），不发起云端调用", async () => {
    const client = makeDangerClient();
    const svc = makeDangerService(client);
    for (const cap of ["Unlock", "FactoryReset"]) {
      const r = await svc.executeAction("did.danger", cap);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("高危");
      expect(r.message).toContain("米家 App");
    }
    expect(client.specAction).not.toHaveBeenCalled();
  });

  it("executeAction 拒绝真实 spec 击穿正则的高危动作（Format/Add Lock User/Silence/Send Data）", async () => {
    const client = makeDangerClient();
    const svc = makeDangerService(client);
    for (const cap of ["Format", "Add Lock User", "Silence", "Send Data"]) {
      const r = await svc.executeAction("did.danger", cap);
      expect(r.ok, cap).toBe(false);
      expect(r.message, cap).toContain("高危");
    }
    expect(client.specAction).not.toHaveBeenCalled(); // 全部本地拒绝，零云端调用
  });

  it("executeAction 普通动作（On）不受高危过滤影响，正常走 specSet", async () => {
    const client = makeDangerClient();
    const svc = makeDangerService(client);
    const r = await svc.executeAction("did.danger", "On", true);
    expect(r.ok).toBe(true);
    expect(client.specSet).toHaveBeenCalledWith("did.danger", 2, 1, true);
  });

  it("S1 设备类型白名单：lock 类型设备 capabilities 置空（设备仍在列表，LLM 看到的是无可控能力）", async () => {
    const svc = makeLockService();
    const devices = await svc.listDevices();
    const lock = devices.find((d) => d.did === "did.lock")!;
    expect(lock).toBeDefined(); // 设备仍可见名称
    expect(lock.deviceType).toBe("lock");
    expect(lock.capabilities).toHaveLength(0);
    // 无能力后控制被拒，供 LLM 自纠
    const r = await svc.executeAction("did.lock", "On", true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("没有能力");
  });

  it("S1 白名单类型（light）能力正常放行", async () => {
    const svc = makeService();
    const light = (await svc.listDevices()).find((d) => d.did === "did.light")!;
    expect(light.capabilities.length).toBeGreaterThan(0);
  });

  it("S1 自定义 typeAllowlist 生效：['lock'] 时门锁能力可用", async () => {
    const client = makeLockClient();
    const svc = new MiDeviceService({
      client: client as unknown as MiClient,
      fetchSpecJson: async () => specOf(lockSpec, "lock"),
      typeAllowlist: ["lock"],
    });
    const lock = (await svc.listDevices()).find((d) => d.did === "did.lock")!;
    expect(lock.capabilities.length).toBeGreaterThan(0);
    const r = await svc.executeAction("did.lock", "On", true);
    expect(r.ok).toBe(true);
    expect(client.specSet).toHaveBeenCalledWith("did.lock", 4, 1, true);
  });

  it("S1 typeAllowlist 大小写不敏感（'Light' 放行 light 类型）", async () => {
    const svc = new MiDeviceService({
      client: makeClient() as unknown as MiClient,
      fetchSpecJson: async (model) =>
        model === "philips.light.bulb" ? specOf(lightSpec, "light") : specOf({ services: [] }, "air-conditioner"),
      typeAllowlist: ["Light"],
    });
    const light = (await svc.listDevices()).find((d) => d.did === "did.light")!;
    expect(light.capabilities.length).toBeGreaterThan(0);
  });

  it("S1 无 spec（undefined）设备照旧无能力", async () => {
    const svc = new MiDeviceService({
      client: makeClient() as unknown as MiClient,
      fetchSpecJson: async () => undefined,
    });
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.capabilities.length === 0)).toBe(true);
    expect(devices.every((d) => d.deviceType === undefined)).toBe(true);
  });

  it("S3 bool 能力传对象被拒，不发起云端调用", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Switch Status", { on: true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("不符合");
    expect(r.message).toContain("开关");
    expect(r.message).toContain("bool");
    expect(client.specSet).not.toHaveBeenCalled();
  });

  it("S3 uint8 能力超出 value-range 被拒并提示范围", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Brightness", 9999);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("不符合");
    expect(r.message).toContain("uint8");
    expect(r.message).toContain("1");
    expect(r.message).toContain("100");
    expect(client.specSet).not.toHaveBeenCalled();
  });

  it("S3 string 能力传 number 被拒", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Name", 123);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("不符合");
    expect(r.message).toContain("string");
    expect(client.specSet).not.toHaveBeenCalled();
  });

  it("S3 合法值正常执行：bool/范围内 uint8/string 各走一次云端", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    expect((await svc.executeAction("did.typed", "Switch Status", true)).ok).toBe(true);
    expect((await svc.executeAction("did.typed", "Brightness", 50)).ok).toBe(true);
    expect((await svc.executeAction("did.typed", "Name", "卧室灯")).ok).toBe(true);
    expect(client.specSet).toHaveBeenCalledTimes(3);
  });

  it("S3 property 能力缺 value 参数被拒（要求必传，供 LLM 自纠）", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Brightness");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("value");
    expect(client.specSet).not.toHaveBeenCalled();
  });

  it("S3 action 能力缺 value 放行（无参动作传空数组）", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Blink");
    expect(r.ok).toBe(true);
    expect(client.specAction).toHaveBeenCalledWith("did.typed", 2, 1, []);
  });

  it("S3 action 能力 in 数组含对象元素被拒（只允许基础类型）", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Blink", [{ piid: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("不符合");
    expect(client.specAction).not.toHaveBeenCalled();
  });

  it("S3 action 能力 in 数组为基础类型时正常执行", async () => {
    const client = makeTypedClient();
    const svc = makeTypedService(client);
    const r = await svc.executeAction("did.typed", "Blink", [1, "快"]);
    expect(r.ok).toBe(true);
    expect(client.specAction).toHaveBeenCalledWith("did.typed", 2, 1, [1, "快"]);
  });

  it("S5 denylist 大小写不敏感：'Lock' 命中 model 'lumi.lock.acn001'", async () => {
    const client = makeClient();
    client.listRawDevices = vi.fn(async () => [
      { did: "did.l1", name: "大门锁", model: "lumi.lock.acn001" },
    ]) as unknown as MockClient["listRawDevices"];
    const svc = new MiDeviceService({
      client: client as unknown as MiClient,
      denylist: ["Lock"],
      fetchSpecJson: async () => specOf(lockSpec, "lock"),
    });
    expect(await svc.listDevices()).toHaveLength(0);
  });

  it("denylist 命中 model 的设备不出现在 listDevices（LLM 看不见）", async () => {
    const svc = new MiDeviceService({
      client: makeClient() as unknown as MiClient,
      denylist: ["philips.light.bulb"],
      fetchSpecJson: async () => specOf(lightSpec, "light"),
    });
    const devices = await svc.listDevices();
    expect(devices.find((d) => d.did === "did.light")).toBeUndefined();
    expect(devices.find((d) => d.did === "did.ac")).toBeDefined(); // 未命中不过滤
  });

  it("denylist 命中 name 子串的设备同样被过滤", async () => {
    const svc = new MiDeviceService({
      client: makeClient() as unknown as MiClient,
      denylist: ["主灯"],
      fetchSpecJson: async () => specOf(lightSpec, "light"),
    });
    const devices = await svc.listDevices();
    expect(devices.find((d) => d.did === "did.light")).toBeUndefined();
    expect(devices).toHaveLength(1);
  });

  it("不配置 denylist 时不过滤（向后兼容）", async () => {
    const svc = makeService();
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(2);
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
        fetchSpecJson: async () => specOf({ services: [] }, "light"),
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
      const fetchSpecJson = vi.fn(async () => specOf({ services: [] }, "light"));
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
      const fetchSpecJson = vi.fn(async () => specOf({ services: [] }, "light"));
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
        return model === "philips.light.bulb"
          ? specOf(lightSpec, "light")
          : specOf({ services: [] }, "air-conditioner");
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
        return specOf({ services: [] }, "air-conditioner");
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
