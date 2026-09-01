import { describe, expect, it, vi, type Mock } from "vitest";
import { MiDeviceService } from "../src/mi/devices.js";
import type { MiClient } from "../src/mi/client.js";

interface MockClient {
  listRawDevices: Mock;
  specGet: Mock;
  specSet: Mock;
  specAction: Mock;
}

const lightSpec = {
  services: [
    {
      siid: 2,
      description: "Bulb",
      properties: [
        { piid: 1, description: "On", format: "bool", access: ["read", "write"] },
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

describe("MiDeviceService", () => {
  it("listDevices 合并设备列表与 spec 能力", async () => {
    const svc = makeService();
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(2);
    const light = devices.find((d) => d.did === "did.light")!;
    expect(light.name).toBe("客厅主灯");
    expect(light.capabilities).toHaveLength(1);
    expect(light.capabilities[0]).toMatchObject({ name: "On", desc: "开关", piid: 1 });
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

  it("executeAction 对 property 能力走 specSet", async () => {
    const client = makeClient();
    const svc = makeService(client);
    const r = await svc.executeAction("did.light", "On", false);
    expect(r.ok).toBe(true);
    expect(client.specSet).toHaveBeenCalledWith("did.light", 2, 1, false);
  });

  it("executeAction 对未知能力返回失败并列出可用能力（供 LLM 自纠）", async () => {
    const svc = makeService();
    const r = await svc.executeAction("did.light", "Brightness", 80);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("On");
  });

  it("executeAction 对不存在的设备返回失败并列出设备名单", async () => {
    const svc = makeService();
    const r = await svc.executeAction("did.ghost", "On", true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("客厅主灯");
    expect(r.message).toContain("卧室空调");
  });

  it("getDeviceState 返回能力名->值映射", async () => {
    const svc = makeService();
    const state = await svc.getDeviceState("did.light");
    expect(state).toEqual({ did: "did.light", properties: { On: true } });
  });
});
