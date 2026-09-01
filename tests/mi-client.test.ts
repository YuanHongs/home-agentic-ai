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
    // 私有方法的逃生舱目标（运行时可通过 as any 访问）
    _callMiotSpec = vi.fn(async () => [{ code: 0, value: true }]);
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

  it("specSet 对任意 did 调用 /miotspec/prop/set", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.specSet("did.other", 2, 1, true);
    const miIOT: any = (c as any).miIOT;
    expect(miIOT._callMiotSpec).toHaveBeenCalledWith("prop/set", [
      { did: "did.other", siid: 2, piid: 1, value: true },
    ]);
  });

  it("specAction 对任意 did 调用 /miotspec/action", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.specAction("did.other", 2, 1, [60]);
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
});
