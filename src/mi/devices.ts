import type { MiClient } from "./client.js";
import { fetchSpecWithType, parseSpec, type SpecWithType } from "./spec.js";
import { DEFAULT_DEVICE_TYPE_ALLOWLIST_LIST } from "../config.js";
import type {
  ActionResult,
  DeviceCapability,
  DeviceInfo,
  DeviceState,
  IRemoteDevice,
} from "../types.js";

export interface DeviceServiceOptions {
  client: MiClient;
  /** spec 拉取函数（默认走网络，测试注入 fake）：返回 spec json + device type，无 spec 时 undefined */
  fetchSpecJson?: (model: string) => Promise<SpecWithType | undefined>;
  /** 设备目录缓存时长（毫秒）；缺省为永久缓存 */
  refreshMs?: number;
  /**
   * 设备黑名单：命中的设备不进入目录/prompt（LLM 看不见、不可控）。
   * 条目对设备 name 或 model 做包含匹配（大小写不敏感）。默认排除音箱自身
   * （防"关掉小爱"瘫痪 AI 入口），来自 config.deviceDenylist。
   */
  denylist?: string[];
  /**
   * 设备类型白名单（CR4-S1，主防线）：MIoT spec URN 第 4 段的类型不在名单内时
   * 该设备 capabilities 置空——设备仍进列表可见名称，但 LLM 看到的是"无可控能力"。
   * 门锁/摄像头/网关/报警器等高危类型由此结构性挡住（正则黑名单只是第二道）。
   * 缺省用 config 的 DEFAULT_DEVICE_TYPE_ALLOWLIST。
   */
  typeAllowlist?: string[];
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

const defaultFetchSpecJson = async (model: string): Promise<SpecWithType | undefined> =>
  fetchSpecWithType(model, async (url) => {
    // miot-spec.org 偶发挂起：10s 超时避免设备列表被单个请求卡死
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`spec 拉取失败 ${res.status}: ${model}`);
    return res.json();
  });

/**
 * 高危动作名模式——纵深防御第二道（主防线是 S1 设备类型白名单 typeAllowlist）。
 * 第四轮红队实测击穿了旧正则（只查 unlock/reboot/reset/factory/delete/remove）：
 * 摄像头 `Format`（抹 SD 卡）、门锁 `Add Lock User`（新增开锁凭据）、
 * 燃气报警器 `silence`（静默报警）、网关 `arming-mode`（布防）全部放行。
 * 本正则按真实 spec 的危险能力名扩充；即便白名单设备的 spec 里混入这类动作，
 * 也一律拒绝且不发起云端调用，引导用户走米家 App（有账号鉴权 + 二次确认）。
 */
const DANGEROUS_ACTION_RE =
  /unlock|reboot|reset|factory|delete|remove|format|erase|clear|init|arming|disarm|add.*user|sync.*user|silence|send.*data|pop\s*up/i;

/** 数值类 format（uint8/int8/.../float/double） */
const NUMBER_FORMAT_RE = /^(u?int(8|16|32|64)|float|double)$/;

/** 值的简短可读形式（自纠消息用，超长截断） */
const describeValue = (v: unknown): string => {
  const s = typeof v === "string" ? JSON.stringify(v) : String(v);
  return s.length > 50 ? `${s.slice(0, 50)}…` : s;
};

/** 能力期望值的可读描述：格式 + 范围 + 枚举（自纠消息用） */
const expectDesc = (cap: DeviceCapability): string => {
  const parts: string[] = [];
  if (cap.format) parts.push(cap.format);
  if (cap.constraint) parts.push(`${cap.constraint.min ?? "-∞"}~${cap.constraint.max ?? "+∞"}`);
  if (cap.values?.length) parts.push(`[${cap.values.map(describeValue).join("/")}]`);
  return parts.join(" ") || "未知格式";
};

/** 智能体层的设备门面：目录解析 + 控制执行，实现 IRemoteDevice */
export class MiDeviceService implements IRemoteDevice {
  private cache?: DeviceInfo[];
  private cachedAt?: number;
  /** 按 model 的能力缓存：MIoT spec 对同一 model 不可变，首次拉取成功后永不再拉 */
  private readonly capCache = new Map<string, { caps: DeviceCapability[]; deviceType?: string }>();
  /** 设备类型白名单（小写归一；缺省用 config 默认白名单） */
  private readonly typeAllowSet: Set<string>;

  constructor(private readonly opts: DeviceServiceOptions) {
    this.typeAllowSet = new Set(
      (opts.typeAllowlist ?? DEFAULT_DEVICE_TYPE_ALLOWLIST_LIST)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  private get specJson(): (model: string) => Promise<SpecWithType | undefined> {
    return this.opts.fetchSpecJson ?? defaultFetchSpecJson;
  }

  /** 首见 model 拉取并缓存 spec 能力；已知 model 直接复用；瞬时失败不落缓存（下轮可重试） */
  private async capabilitiesFor(
    model: string,
  ): Promise<{ caps: DeviceCapability[]; deviceType?: string }> {
    const cached = this.capCache.get(model);
    if (cached) return cached;
    try {
      const spec = await this.specJson(model);
      // S1 主防线：类型不在白名单 → 能力置空（设备仍可见，LLM 看到的是"无可控能力"）
      const entry = spec
        ? {
            deviceType: spec.deviceType,
            caps: this.typeAllowSet.has(spec.deviceType.toLowerCase())
              ? parseSpec(model, spec.json)
              : this.blockedCaps(model, spec.deviceType),
          }
        : { caps: [] };
      this.capCache.set(model, entry);
      return entry;
    } catch (err) {
      // spec 拉取失败（含 instances 列表失败，见 spec.ts）不阻塞设备列表；
      // 该设备仅暂时失去精细控制能力——留一行日志保证失败可观测
      console.error(
        `[MiDeviceService] spec 拉取失败（${model}），该设备暂失精细控制:`,
        (err as Error).message,
      );
      return { caps: [] };
    }
  }

  /** 类型被白名单挡住：返回空能力并打一行可观测日志（首见 model 仅此一次） */
  private blockedCaps(model: string, deviceType: string): DeviceCapability[] {
    console.error(
      `[MiDeviceService] 设备类型 %s 不在白名单，已禁用能力控制（model=%s）。如需放行请配置 DEVICE_TYPE_ALLOWLIST`,
      deviceType,
      model,
    );
    return [];
  }

  /** 黑名单命中：条目包含匹配设备名或型号（大小写不敏感，如 "Lock" 命中 lumi.lock.acn001） */
  private isDenied(d: { name: string; model: string }): boolean {
    const name = d.name.toLowerCase();
    const model = d.model.toLowerCase();
    return (this.opts.denylist ?? []).some((entry) => {
      const e = entry.trim().toLowerCase();
      return e !== "" && (name.includes(e) || model.includes(e));
    });
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const fresh =
      this.cache !== undefined &&
      (this.opts.refreshMs === undefined || Date.now() - (this.cachedAt ?? 0) < this.opts.refreshMs);
    if (fresh) return this.cache!;
    const raw = (await this.opts.client.listRawDevices()).filter((d) => !this.isDenied(d));
    const devices = await Promise.all(
      raw.map(async (d): Promise<DeviceInfo> => {
        const { caps, deviceType } = await this.capabilitiesFor(d.model);
        return {
          did: d.did,
          name: d.name,
          model: d.model,
          room: d.room_name,
          deviceType,
          capabilities: caps,
        };
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

  /**
   * S3 值类型与范围校验（property 类能力）：不匹配返回自纠消息，不发起云端调用。
   * - bool → 必须 boolean；数值类 format → 必须 number 且在 value-range 内（有约束时）
   * - string → 必须 string；未知 format 不校验（spec 新格式前向兼容）
   * - value 缺省（undefined）要求必传（property 类）
   */
  private validatePropertyValue(cap: DeviceCapability, value: unknown): string | undefined {
    if (value === undefined) {
      return `能力 ${cap.desc}（${cap.name}）需要 value 参数（期望 ${expectDesc(cap)}）`;
    }
    const fmt = cap.format ?? "";
    if (fmt === "bool" && typeof value !== "boolean") {
      return `值 ${describeValue(value)} 不符合能力 ${cap.desc} 的格式（期望 ${expectDesc(cap)}）`;
    }
    if (NUMBER_FORMAT_RE.test(fmt)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `值 ${describeValue(value)} 不符合能力 ${cap.desc} 的格式（期望 ${expectDesc(cap)}）`;
      }
      if (cap.constraint && (value < (cap.constraint.min ?? -Infinity) || value > (cap.constraint.max ?? Infinity))) {
        return `值 ${describeValue(value)} 不符合能力 ${cap.desc} 的格式（期望 ${expectDesc(cap)}）`;
      }
    }
    if (fmt === "string" && typeof value !== "string") {
      return `值 ${describeValue(value)} 不符合能力 ${cap.desc} 的格式（期望 ${expectDesc(cap)}）`;
    }
    return undefined;
  }

  /**
   * S3 值校验（action 类能力）：in 数组每个元素必须是基础类型
   * （string/number/boolean）——对象/数组元素拒绝，防结构化注入。
   * value 缺省（undefined）放行（无参动作）。
   */
  private validateActionArgs(cap: DeviceCapability, value: unknown): string | undefined {
    if (value === undefined) return undefined;
    const args = Array.isArray(value) ? value : [value];
    for (const a of args) {
      if (typeof a === "object" && a !== null) {
        return `参数 ${describeValue(a)} 不符合能力 ${cap.desc} 的格式（期望基础类型 string/number/boolean，不支持对象或数组）`;
      }
    }
    return undefined;
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
    // 高危动作名（Unlock/Format/Add Lock User/...）本地直接拒绝，不发起云端调用
    if (DANGEROUS_ACTION_RE.test(cap.name)) {
      return { ok: false, message: `「${cap.desc}」属于高危操作，已拒绝。请通过米家 App 操作。` };
    }
    // S3 值校验：不匹配本地拒绝（不发起云端调用），消息带期望格式供 LLM 自纠
    const valueError =
      cap.kind === "property"
        ? this.validatePropertyValue(cap, value)
        : this.validateActionArgs(cap, value);
    if (valueError) return { ok: false, message: valueError };
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
