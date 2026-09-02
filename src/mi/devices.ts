import type { MiClient } from "./client.js";
import { fetchSpec, parseSpec } from "./spec.js";
import type {
  ActionResult,
  DeviceCapability,
  DeviceInfo,
  DeviceState,
  IRemoteDevice,
} from "../types.js";

export interface DeviceServiceOptions {
  client: MiClient;
  /** spec 拉取函数（默认走网络，测试注入 fake） */
  fetchSpecJson?: (model: string) => Promise<unknown>;
  /** 设备目录缓存时长（毫秒）；缺省为永久缓存 */
  refreshMs?: number;
  /**
   * 设备黑名单：命中的设备不进入目录/prompt（LLM 看不见、不可控）。
   * 条目对设备 name 或 model 做包含匹配。默认排除音箱自身（防"关掉小爱"
   * 瘫痪 AI 入口），来自 config.deviceDenylist。
   */
  denylist?: string[];
}

/**
 * 模糊匹配强度：查询串包含设备名中 ≥2 字连续片段的最长长度
 * （如 "客厅的灯" 命中 "客厅主灯" 的 "客厅" → 2；无命中 → 0）
 */
const longestMatchLen = (query: string, name: string): number => {
  for (let len = name.length; len >= 2; len--) {
    for (let start = 0; start + len <= name.length; start++) {
      if (query.includes(name.slice(start, start + len))) return len;
    }
  }
  return 0;
};

const defaultFetchSpecJson = async (model: string): Promise<unknown> =>
  fetchSpec(model, async (url) => {
    // miot-spec.org 偶发挂起：10s 超时避免设备列表被单个请求卡死
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`spec 拉取失败 ${res.status}: ${model}`);
    return res.json();
  });

/**
 * 高危动作名模式：解锁/重启/恢复出厂/删除类操作一旦被 prompt 注入或误触发，
 * 后果不可逆（门锁被语音打开、设备被重置）。语音链路不鉴权，这类动作
 * 一律拒绝且不发起云端调用，引导用户走米家 App（有账号鉴权 + 二次确认）。
 */
const DANGEROUS_ACTION_RE = /unlock|reboot|reset|factory|delete|remove/i;

/** 智能体层的设备门面：目录解析 + 控制执行，实现 IRemoteDevice */
export class MiDeviceService implements IRemoteDevice {
  private cache?: DeviceInfo[];
  private cachedAt?: number;
  /** 按 model 的能力缓存：MIoT spec 对同一 model 不可变，首次拉取成功后永不再拉 */
  private readonly capCache = new Map<string, DeviceCapability[]>();

  constructor(private readonly opts: DeviceServiceOptions) {}

  private get specJson(): (model: string) => Promise<unknown> {
    return this.opts.fetchSpecJson ?? defaultFetchSpecJson;
  }

  /** 首见 model 拉取并缓存 spec 能力；已知 model 直接复用；瞬时失败不落缓存（下轮可重试） */
  private async capabilitiesFor(model: string): Promise<DeviceCapability[]> {
    const cached = this.capCache.get(model);
    if (cached) return cached;
    try {
      const capabilities = parseSpec(model, await this.specJson(model));
      this.capCache.set(model, capabilities);
      return capabilities;
    } catch (err) {
      // spec 拉取失败（含 instances 列表失败，见 spec.ts）不阻塞设备列表；
      // 该设备仅暂时失去精细控制能力——留一行日志保证失败可观测
      console.error(
        `[MiDeviceService] spec 拉取失败（${model}），该设备暂失精细控制:`,
        (err as Error).message,
      );
      return [];
    }
  }

  /** 黑名单命中：条目包含匹配设备名或型号（如 "xiaomi.wifispeaker" 命中音箱 model） */
  private isDenied(d: { name: string; model: string }): boolean {
    return (this.opts.denylist ?? []).some(
      (entry) => entry !== "" && (d.name.includes(entry) || d.model.includes(entry)),
    );
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const fresh =
      this.cache !== undefined &&
      (this.opts.refreshMs === undefined || Date.now() - (this.cachedAt ?? 0) < this.opts.refreshMs);
    if (fresh) return this.cache!;
    const raw = (await this.opts.client.listRawDevices()).filter((d) => !this.isDenied(d));
    const devices = await Promise.all(
      raw.map(async (d): Promise<DeviceInfo> => {
        const capabilities = await this.capabilitiesFor(d.model);
        return { did: d.did, name: d.name, model: d.model, room: d.room_name, capabilities };
      }),
    );
    this.cache = devices;
    this.cachedAt = Date.now();
    return devices;
  }

  /** 设备名解析：did 精确匹配优先，其次名称精确/包含匹配，最后全局最优模糊匹配（并列则不猜） */
  async resolveDevice(nameOrDid: string): Promise<DeviceInfo | undefined> {
    // 空串防御：LLM 缺 device 参数时会传 ""，includes("") 恒真会误命中第一台设备
    if (!nameOrDid.trim()) return undefined;
    const devices = await this.listDevices();
    const exact =
      devices.find((d) => d.did === nameOrDid) ??
      devices.find((d) => d.name === nameOrDid);
    if (exact) return exact;
    // substring 层：与模糊层"并列不猜"对齐——命中多台（如"客厅空调"+"卧室空调查'空调'"）
    // 返回 undefined 让 LLM 澄清，而不是开列表第一台
    const substring = devices.filter(
      (d) => nameOrDid.includes(d.name) || d.name.includes(nameOrDid),
    );
    if (substring.length === 1) return substring[0];
    if (substring.length > 1) return undefined;
    // 模糊层级：跨全部设备取最长命中片段，唯一全局最优者胜出；
    // 并列最优（如两盏 "…主灯" 都只命中 "主灯"）时无法区分，返回 undefined 让上层 LLM 自纠
    let best: DeviceInfo | undefined;
    let bestLen = 1; // 片段最短 2 字，1 作为"尚无命中"哨兵
    let tie = false;
    for (const d of devices) {
      const len = longestMatchLen(nameOrDid, d.name);
      if (len > bestLen) {
        best = d;
        bestLen = len;
        tie = false;
      } else if (len === bestLen && best !== undefined) {
        tie = true;
      }
    }
    return tie ? undefined : best;
  }

  async getDeviceState(did: string): Promise<DeviceState> {
    const device = (await this.listDevices()).find((d) => d.did === did);
    if (!device) throw new Error(`设备不存在: ${did}`);
    const readable = device.capabilities.filter(
      (c) => c.kind === "property" && c.piid !== undefined && c.access?.includes("read"),
    );
    if (readable.length === 0) return { did, properties: {} };
    const entries = readable.map((c) => ({ siid: c.siid, piid: c.piid! }));
    const res = await this.opts.client.specGet(did, entries);
    // specGet 可能因登录态失效/网络错返回 undefined——防御不炸整轮对话（与 executeAction 对齐）
    if (!Array.isArray(res)) {
      console.error(`[MiDeviceService] specGet 返回异常（登录态可能失效），did=${did}`);
      return { did, properties: {} };
    }
    const properties: Record<string, unknown> = {};
    res.forEach((item: any, i: number) => {
      if (item?.code === 0) properties[readable[i].name] = item.value;
    });
    return { did, properties };
  }

  async executeAction(did: string, capability: string, value?: unknown): Promise<ActionResult> {
    const devices = await this.listDevices();
    const device = devices.find((d) => d.did === did);
    if (!device) {
      const list = devices.map((d) => `${d.name}(${d.did})`).join("、");
      return { ok: false, message: `未找到设备 ${did}。可用设备：${list}` };
    }
    const cap = device.capabilities.find((c) => c.name === capability);
    if (!cap) {
      const list = device.capabilities.map((c) => `${c.name}(${c.desc})`).join("、") || "无";
      return { ok: false, message: `设备 ${device.name} 没有能力 ${capability}。可用能力：${list}` };
    }
    // 高危动作名（Unlock/FactoryReset/...）本地直接拒绝，不发起云端调用
    if (DANGEROUS_ACTION_RE.test(cap.name)) {
      return { ok: false, message: `「${cap.desc}」属于高危操作，已拒绝。请通过米家 App 操作。` };
    }
    try {
      const ok =
        cap.kind === "property"
          ? await this.opts.client.specSet(did, cap.siid, cap.piid!, value)
          : await this.opts.client.specAction(did, cap.siid, cap.aiid!, value === undefined ? [] : Array.isArray(value) ? value : [value]);
      return ok
        ? { ok: true, message: `已执行 ${device.name}.${cap.desc}` }
        : { ok: false, message: `设备 ${device.name} 执行 ${cap.desc} 失败（云端返回失败）` };
    } catch (err) {
      return { ok: false, message: `设备 ${device.name} 执行 ${cap.desc} 出错: ${(err as Error).message}` };
    }
  }
}
