import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mi-service-lite", () => {
  const MiNA = class {
    pause = vi.fn(async () => true);
    getConversations = vi.fn(async () => ({
      records: [
        {
          query: "请开灯",
          time: 200,
          answers: [{ type: "TTS" }],
        },
        {
          query: "放首歌",
          time: 150,
          answers: [{ type: "TTS" }, { type: "Audio" }], // 播音乐：两条答案，过滤掉
        },
      ],
    }));
  };
  const MiIOT = class {
    doAction = vi.fn(async () => true);
    getDevices = vi.fn(async () => []);
    // 私有方法的逃生舱目标（运行时可通过 as any 访问）。
    // 真实端点形状（实测）：prop/get、prop/set 返回数组 [{code,value,...}]，action 返回对象 {code}
    _callMiotSpec = vi.fn(async (command: string) =>
      command === "action" ? { code: 0 } : [{ code: 0, value: true }],
    );
  };
  return {
    getMiNA: vi.fn(async () => new MiNA()),
    getMiIOT: vi.fn(async () => new MiIOT()),
  };
});

import { getMiNA, getMiIOT } from "mi-service-lite";
import { MiClient } from "../src/mi/client.js";

const config = {
  miUserId: "u",
  miPassword: "p",
  miDid: "did.1",
  ttsCommand: [3, 1] as [number, number],
  wakeUpCommand: [3, 2] as [number, number],
};

describe("MiClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("init 登录并初始化 MiNA/MiIOT", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(getMiNA).toHaveBeenCalledWith(expect.objectContaining({ did: "did.1" }));
    expect(getMiIOT).toHaveBeenCalledWith(expect.objectContaining({ did: "did.1" }));
  });

  it("getLatestRecords 过滤非 TTS/LLM 单答案记录并映射字段", async () => {
    const c = new MiClient(config);
    await c.init();
    const records = await c.getLatestRecords(10);
    expect(records).toEqual([{ text: "请开灯", timestamp: 200 }]);
  });

  it("speak 走 ttsCommand 的 doAction", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.speak("晚安");
    const miIOT: any = (c as any).miIOT;
    expect(miIOT.doAction).toHaveBeenCalledWith(3, 1, "晚安");
  });

  it("specSet 对任意 did 调用 /miotspec/prop/set，成功返回 true", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(await c.specSet("did.other", 2, 1, true)).toBe(true);
    const miIOT: any = (c as any).miIOT;
    expect(miIOT._callMiotSpec).toHaveBeenCalledWith("prop/set", [
      { did: "did.other", siid: 2, piid: 1, value: true },
    ]);
  });

  it("specAction 对任意 did 调用 /miotspec/action，成功返回 true", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(await c.specAction("did.other", 2, 1, [60])).toBe(true);
    const miIOT: any = (c as any).miIOT;
    expect(miIOT._callMiotSpec).toHaveBeenCalledWith("action", {
      did: "did.other",
      siid: 2,
      aiid: 1,
      in: [60],
    });
  });

  it("调用失败后 ensureAlive 重新登录一次", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(getMiNA).toHaveBeenCalledTimes(1);
    (c as any).miIOT = undefined; // 模拟登录态丢失
    await c.ensureAlive();
    expect(getMiNA).toHaveBeenCalledTimes(2);
  });

  it("getConversations 返回 undefined 时抛错（不吞掉登录态失效，激活自愈路径）", async () => {
    const c = new MiClient(config);
    await c.init();
    (c as any).miNA.getConversations.mockResolvedValueOnce(undefined);
    await expect(c.getLatestRecords(10)).rejects.toThrow("拉取对话失败");
  });

  it("getDevices 返回 undefined 时抛错（不用空列表覆盖好快照）", async () => {
    const c = new MiClient(config);
    await c.init();
    (c as any).miIOT.getDevices.mockResolvedValueOnce(undefined);
    await expect(c.listRawDevices()).rejects.toThrow("拉取设备列表失败");
  });

  it("ensureAlive(true) 无条件强制重登获取新 token", async () => {
    const c = new MiClient(config);
    await c.init();
    expect(getMiNA).toHaveBeenCalledTimes(1);
    expect(getMiIOT).toHaveBeenCalledTimes(1);
    await c.ensureAlive(true);
    expect(getMiNA).toHaveBeenCalledTimes(2);
    expect(getMiIOT).toHaveBeenCalledTimes(2);
  });

  it("speak 时 doAction 返回 false 则记录失败日志（失败可见，不静默）", async () => {
    const c = new MiClient(config);
    await c.init();
    (c as any).miIOT.doAction.mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await c.speak("测试播报");
      expect(errSpy).toHaveBeenCalledWith("[MiClient] TTS 播报指令下发失败");
    } finally {
      errSpy.mockRestore();
    }
  });
});
