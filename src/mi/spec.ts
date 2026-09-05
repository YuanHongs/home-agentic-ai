import type { DeviceCapability } from "../types.js";

/** 常见能力名的中文映射（spec 无 comment 字段时的回退，未命中时保留英文原名） */
const ZH: Record<string, string> = {
  "Switch Status": "开关",
  On: "开关",
  Brightness: "亮度",
  "Color Temperature": "色温",
  Mode: "模式",
  "Fan Level": "风速",
  "Target Temperature": "目标温度",
  "Air Conditioner": "空调开关",
  Volume: "音量",
  Status: "状态",
  "Current Temperature": "当前温度",
};

/**
 * 真实 MIoT spec JSON 形状（实测 2026-09-02）：
 * 每层都用 `iid`（service.iid 即 siid、property.iid 即 piid、action.iid 即 aiid）；
 * `description` 是英文，`comment` 是中文。
 */
interface SpecProperty {
  iid: number;
  description: string;
  comment?: string;
  format?: string;
  access?: string[];
  /** [min, max, step] */
  "value-range"?: unknown;
  /** [{ value, description }, ...] */
  "value-list"?: unknown;
}
interface SpecAction {
  iid: number;
  description: string;
  comment?: string;
}
interface SpecService {
  iid: number;
  description: string;
  properties?: SpecProperty[];
  actions?: SpecAction[];
}

/** desc 取值顺序：中文 comment 优先，其次 ZH 映射表，最后英文 description 原文 */
const descOf = (item: { description: string; comment?: string }): string =>
  item.comment?.trim() ? item.comment : (ZH[item.description] ?? item.description);

/** value-range [min,max,step] → constraint（取前两段；非法形状不产出约束） */
const parseConstraint = (range: unknown): { min?: number; max?: number } | undefined => {
  if (!Array.isArray(range) || range.length < 2) return undefined;
  const [min, max] = range;
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  return { min, max };
};

/** value-list [{value,description},...] → values（取每项的 value 字段；非法形状不产出） */
const parseValues = (list: unknown): unknown[] | undefined => {
  if (!Array.isArray(list)) return undefined;
  return list.map((e) =>
    typeof e === "object" && e !== null && "value" in e ? (e as { value: unknown }).value : e,
  );
};

export function parseSpec(model: string, specJson: unknown): DeviceCapability[] {
  const services: SpecService[] = (specJson as { services?: SpecService[] })?.services ?? [];
  const caps: DeviceCapability[] = [];
  for (const svc of services) {
    if (svc.description === "Device Information") continue; // 无控制价值的标配服务
    for (const prop of svc.properties ?? []) {
      const writable = prop.access?.includes("write");
      if (!writable) continue;
      // 空名防御（CR4-S2）：真实 spec 大量存在只有 comment、description 为空的字段，
      // 它们会成为 name:"" 的能力——executeAction 里 String(undefined ?? "") 意外命中
      if (typeof prop.description !== "string" || !prop.description.trim()) continue;
      const constraint = parseConstraint(prop["value-range"]);
      const values = parseValues(prop["value-list"]);
      caps.push({
        kind: "property",
        siid: svc.iid,
        piid: prop.iid,
        name: prop.description,
        desc: descOf(prop),
        format: prop.format,
        access: prop.access,
        ...(constraint ? { constraint } : {}),
        ...(values ? { values } : {}),
      });
    }
    for (const act of svc.actions ?? []) {
      if (typeof act.description !== "string" || !act.description.trim()) continue; // 空名防御（CR4-S2）
      caps.push({
        kind: "action",
        siid: svc.iid,
        aiid: act.iid,
        name: act.description,
        desc: descOf(act),
      });
    }
  }
  return caps;
}

/** 从 miot-spec.org 拉取设备 spec（httpGet 注入以便测试）。
 *  实测（2026-09-02）：instance 端点只收 URN 不收 model 名，且 home.miot-spec.com 已 404；
 *  故先拉全量 instances 列表（进程内缓存，列表只增不改），解析出 URN 后再拉具体 spec。 */
const INSTANCES_URL = "https://miot-spec.org/miot-spec-v2/instances";
const INSTANCE_URL = "https://miot-spec.org/miot-spec-v2/instance";

/** instances 列表缓存：列表只增不改，拉一次够用；并发去重靠 in-flight promise */
let instancesCache: string[] | undefined;
let instancesInflight: Promise<string[]> | undefined;

/** 测试隔离用：清空 instances 进程内缓存 */
export function _resetInstancesCacheForTest(): void {
  instancesCache = undefined;
  instancesInflight = undefined;
}

/**
 * 纯函数：按 model 解析对应的 spec URN。
 * 映射规律（实测）：model 按 "." 切分，首段=vendor、末段=型号尾；
 * URN 第6段恰为 `vendor-型号尾`（中间的 type 词不对应，不能用作硬性匹配条件）；
 * 第7段为版本号，多个 URN 命中时取版本号最大者；版本相同时取 7 段形式。
 * 8 段 URN（实测占 28%）是 BLE-mesh 网关下挂的第三方子设备变体，尾部多一段
 * 子设备 service hash（如 `...:yeelink-meshbulb2:1:0000C802`），其中
 * 11,807 个 vendor-tail 只以 8 段形式存在——hash 不参与匹配但保留在返回值里。
 *
 * 版本相同时 7 段优先（CR2 修复）：复审实测（2026-09-02）同 vendor-tail 共存
 * 同版本的 7 段与 8 段 URN 几乎全是不同设备类型（如 ghome-sf001 的 7 段是
 * Light spec、8 段是 Switch spec），并非"同一设备的两种编码"——故取主体设备
 * 的 7 段；8 段独占的 vendor-tail（无 7 段竞争）不受影响，照常命中。
 * 同版本存在多候选（多段数/多类型）是歧义场景：打一行 console.error 让这类
 * 设备可观测。
 *
 * 中段词消歧（CR4 正确性波）：同一 vendor-tail 可能挂着多个不同设备类型的
 * URN（viomi.vacuum.v8 实测有 9 个类型），纯 max-version 会选中错误类型
 * （版本更大的 hood 抢走 vacuum）。model 中段是设备类别的描述词，优先在
 * URN type 段（seg[3]）与中段匹配的候选里按现有规则选择；无中段匹配时
 * 回退原有行为。匹配语义分两档（见函数内注释）。
 */
export function resolveUrn(model: string, instances: string[]): string | undefined {
  const parts = model.split(".");
  if (parts.length < 2) return undefined;
  const [vendor, tail] = [parts[0], parts[parts.length - 1]];
  // 中段词（viomi.vacuum.v8 的 "vacuum"、chuangmi.plug.v3 的 "plug"）；
  // 空段（"a..b"）无信息量且会让包含匹配误判全命中，过滤掉
  const middles = parts.slice(1, -1).filter((s) => s.length > 0);
  const want = `${vendor}-${tail}`;
  const candidates: { urn: string; type: string; version: number; segCount: number }[] = [];
  for (const urn of instances) {
    const seg = urn.split(":"); // [urn, miot-spec-v2, device, <type>, <hash>, <vendor-tail>, <version>, ...子设备 service hash]
    if (seg.length < 7 || seg[5] !== want) continue;
    const version = Number(seg[6]);
    if (Number.isNaN(version)) continue;
    candidates.push({ urn, type: seg[3], version, segCount: seg.length });
  }
  if (candidates.length === 0) return undefined;

  // 中段消歧：匹配分两档，命中任一档后在缩窄后的候选池内按现有规则选择。
  //  1) 精确相等（vacuum == vacuum）：最可信，命中即不再看第 2 档；
  //  2) 双向包含（中段 "wifispeaker" ⊃ type "speaker"）："相等"对复合词太严
  //     （xiaomi.wifispeaker.l09a 的中段与 type speaker），且包含方向不可预知，
  //     故取双向。分档是为了让弱包含（如中段 "light" 包含于 type "nightlight"）
  //     永远抢不走本可精确命中的候选。
  // 无任何中段匹配时回退原有行为（全候选按版本/段数选）。
  let pool = candidates;
  if (middles.length > 0) {
    const exact = candidates.filter((c) => middles.includes(c.type));
    const loose =
      exact.length > 0
        ? exact
        : candidates.filter((c) => middles.some((m) => c.type.includes(m) || m.includes(c.type)));
    if (loose.length > 0 && loose.length < candidates.length) {
      pool = loose;
      console.error(
        "[spec] model %s 中段 %s 命中 device type，%d 个同尾缀候选消歧为 %d 个",
        model,
        middles.join("."),
        candidates.length,
        pool.length,
      );
    }
  }

  const bestVersion = Math.max(...pool.map((c) => c.version));
  const top = pool.filter((c) => c.version === bestVersion);
  // 版本相同优先 7 段（主体设备 spec）；全为 8 段时取首个（8 段独占照常命中）
  const best = top.find((c) => c.segCount === 7) ?? top[0];
  if (top.length > 1) {
    // 带上选中 URN 的 device type 段（seg[3]），让"猜的是哪个类型"可判断
    console.error(
      "[spec] vendor-tail %s 同版本 %s 存在 %d 个候选 URN（多段数/多类型共存，可能为不同设备），按 7 段优先取 %s（device type: %s）",
      want,
      bestVersion,
      top.length,
      best.urn,
      best.urn.split(":")[3],
    );
  }
  return best.urn;
}

async function getInstances(httpGet: (url: string) => Promise<unknown>): Promise<string[]> {
  if (instancesCache) return instancesCache;
  if (!instancesInflight) {
    instancesInflight = (async () => {
      const res = await httpGet(INSTANCES_URL);
      const list = (res as { instances?: string[] })?.instances;
      if (!Array.isArray(list)) throw new Error("miot-spec instances 响应格式异常");
      instancesCache = list;
      return list;
    })().finally(() => {
      instancesInflight = undefined; // 失败不占坑，下次可重试
    });
  }
  return instancesInflight;
}

/** 仅测试消费的便利包装（生产路径请用 fetchSpecWithType——需要 deviceType 做类型白名单） */
export async function fetchSpec(
  model: string,
  httpGet: (url: string) => Promise<unknown>,
): Promise<unknown> {
  return (await fetchSpecWithType(model, httpGet))?.json;
}

/** spec 拉取结果：json + URN 第 4 段的 device type（设备类型白名单的判定依据） */
export interface SpecWithType {
  json: unknown;
  /** URN `urn:miot-spec-v2:device:<type>:...` 的第 4 段，如 light / lock / speaker */
  deviceType: string;
}

/**
 * 拉取 spec 并附带 device type（CR4-S1）。
 * 设备只有解析出 spec 才有能力可控，而 URN 里就带 device type——
 * 在能力入口按类型放行是气密的结构性防线（白名单见 config.DEVICE_TYPE_ALLOWLIST）。
 */
export async function fetchSpecWithType(
  model: string,
  httpGet: (url: string) => Promise<unknown>,
): Promise<SpecWithType | undefined> {
  const instances = await getInstances(httpGet);
  const urn = resolveUrn(model, instances);
  if (!urn) {
    // model 不在 spec 库：按无能力处理，不抛错。
    // 此处打日志让 undefined 路径可观测（不经过 capabilitiesFor 的 catch，否则全程零日志）。
    console.error("[spec] 未找到型号 %s 的 MIoT spec（该设备暂无精细控制能力）", model);
    return undefined;
  }
  const json = await httpGet(`${INSTANCE_URL}?type=${encodeURIComponent(urn)}`);
  // resolveUrn 保证 URN ≥7 段，第 4 段（下标 3）恒为 device type
  return { json, deviceType: urn.split(":")[3] };
}
