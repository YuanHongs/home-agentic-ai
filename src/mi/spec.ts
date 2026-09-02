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
  item.comment ?? ZH[item.description] ?? item.description;

export function parseSpec(model: string, specJson: unknown): DeviceCapability[] {
  const services: SpecService[] = (specJson as { services?: SpecService[] })?.services ?? [];
  const caps: DeviceCapability[] = [];
  for (const svc of services) {
    if (svc.description === "Device Information") continue; // 无控制价值的标配服务
    for (const prop of svc.properties ?? []) {
      const writable = prop.access?.includes("write");
      if (!writable) continue;
      caps.push({
        kind: "property",
        siid: svc.iid,
        piid: prop.iid,
        name: prop.description,
        desc: descOf(prop),
        format: prop.format,
        access: prop.access,
      });
    }
    for (const act of svc.actions ?? []) {
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
 * URN 第6段恰为 `vendor-型号尾`（中间的 type 词不对应，不能用作匹配条件）；
 * 第7段为版本号，多个 URN 命中时取版本号最大者；版本相同时取 8 段完整形式。
 * 8 段 URN（实测占 28%）是 BLE-mesh 网关下挂的第三方子设备，尾部多一段
 * 子设备 service hash（如 `...:yeelink-meshbulb2:1:0000C802`），其中
 * 11,807 个 vendor-tail 只以 8 段形式存在——hash 不参与匹配但保留在返回值里。
 */
export function resolveUrn(model: string, instances: string[]): string | undefined {
  const parts = model.split(".");
  if (parts.length < 2) return undefined;
  const [vendor, tail] = [parts[0], parts[parts.length - 1]];
  const want = `${vendor}-${tail}`;
  let best: string | undefined;
  let bestVersion = -1;
  let bestIsFull = false; // 命中的是否为 8 段完整形式（含子设备 service hash）
  for (const urn of instances) {
    const seg = urn.split(":"); // [urn, miot-spec-v2, device, <type>, <hash>, <vendor-tail>, <version>, ...子设备 service hash]
    if (seg.length < 7 || seg[5] !== want) continue;
    const version = Number(seg[6]);
    if (Number.isNaN(version)) continue;
    const isFull = seg.length > 7;
    if (version > bestVersion || (version === bestVersion && isFull && !bestIsFull)) {
      best = urn;
      bestVersion = version;
      bestIsFull = isFull;
    }
  }
  return best;
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

export async function fetchSpec(
  model: string,
  httpGet: (url: string) => Promise<unknown>,
): Promise<unknown> {
  const instances = await getInstances(httpGet);
  const urn = resolveUrn(model, instances);
  if (!urn) {
    // model 不在 spec 库：按无能力处理，不抛错。
    // 此处打日志让 undefined 路径可观测（不经过 capabilitiesFor 的 catch，否则全程零日志）。
    console.error("[spec] 未找到型号 %s 的 MIoT spec（该设备暂无精细控制能力）", model);
    return undefined;
  }
  return httpGet(`${INSTANCE_URL}?type=${encodeURIComponent(urn)}`);
}
