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
import { MiClient, MiRiskControlError } from "../src/mi/client.js";

const RISK_LINE = "🔥 触发小米账号异地登录安全验证机制，请在浏览器打开以下链接，并按照网页提示授权验证账号：";
const AUTH_URL = "https://account.xiaomi.com/identity/auth?sid=xiaomiio";

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

  it("answers 缺失的记录（技能调用等非对话形状）被过滤且不抛错", async () => {
    const c = new MiClient(config);
    await c.init();
    (c as any).miNA.getConversations.mockResolvedValueOnce({
      records: [
        { query: "今天天气", time: 300 }, // 无 answers 字段：毒记录
        { query: "请开灯", time: 200, answers: [{ type: "TTS" }] },
      ],
    });
    await expect(c.getLatestRecords(10)).resolves.toEqual([
      { text: "请开灯", timestamp: 200 },
    ]);
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

  it("speak 超过 200 字时截断到 200 字加省略号（防 LLM 长文刷屏）", async () => {
    const c = new MiClient(config);
    await c.init();
    await c.speak("长".repeat(250));
    const miIOT: any = (c as any).miIOT;
    const sent: string = miIOT.doAction.mock.calls[0][2];
    expect(sent.length).toBe(202); // 200 字 + "……"
    expect(sent.startsWith("长".repeat(200))).toBe(true);
    expect(sent.endsWith("……")).toBe(true);
  });

  it("pause 返回 false 时记录失败日志（失败可见，不静默）", async () => {
    const c = new MiClient(config);
    await c.init();
    (c as any).miNA.pause.mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await c.pause();
      expect(errSpy).toHaveBeenCalledWith("[MiClient] pause 指令下发失败");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("init 期间库打印风控文案并返回 undefined 时抛 MiRiskControlError（附授权链接）", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // 复现 mi-service-lite getAccount 风控分支：打印文案+链接后返回 undefined
      vi.mocked(getMiNA).mockImplementationOnce(async () => {
        console.log(RISK_LINE);
        console.log("👉 " + AUTH_URL);
        return undefined;
      });
      const c = new MiClient(config);
      const err = await c.init().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(MiRiskControlError);
      expect((err as MiRiskControlError).name).toBe("MiRiskControlError");
      expect((err as MiRiskControlError).authUrl).toBe(AUTH_URL);
      expect((err as MiRiskControlError).message).toContain("已触发小米账号安全验证");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("风控劫持后 console.log 被正确恢复且输出仍透传原函数", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.mocked(getMiNA).mockImplementationOnce(async () => {
        console.log(RISK_LINE);
        return undefined;
      });
      const c = new MiClient(config);
      await expect(c.init()).rejects.toBeInstanceOf(MiRiskControlError);
      // 劫持期间的输出透传到了原函数（spy 即劫持前 console.log 的真身）
      expect(logSpy).toHaveBeenCalledWith(RISK_LINE);
      // finally 已恢复：console.log 回到劫持前的引用，后续正常 log 走原函数
      expect(console.log).toBe(logSpy);
      console.log("正常输出");
      expect(logSpy).toHaveBeenCalledWith("正常输出");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("登录失败但无风控文案时仍抛通用错误（不误判风控）", async () => {
    vi.mocked(getMiNA).mockResolvedValueOnce(undefined);
    vi.mocked(getMiIOT).mockResolvedValueOnce(undefined);
    const c = new MiClient(config);
    const err = await c.init().then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(MiRiskControlError);
    expect((err as Error).message).toContain("小米云登录失败");
  });

  it("风控文案出现在 getMiIOT 阶段同样识别（两个域各自登录）", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.mocked(getMiIOT).mockImplementationOnce(async () => {
        console.log(RISK_LINE);
        console.log("👉 " + AUTH_URL);
        return undefined;
      });
      const c = new MiClient(config);
      await expect(c.init()).rejects.toMatchObject({
        name: "MiRiskControlError",
        authUrl: AUTH_URL,
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
