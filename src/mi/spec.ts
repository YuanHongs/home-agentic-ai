import type { DeviceCapability } from "../types.js";

/** 常见能力名的中文映射（未命中时保留英文原名） */
const ZH: Record<string, string> = {
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

interface SpecProperty {
  piid: number;
  description: string;
  format?: string;
  access?: string[];
}
interface SpecAction {
  aiid: number;
  description: string;
}
interface SpecService {
  siid: number;
  description: string;
  properties?: SpecProperty[];
  actions?: SpecAction[];
}

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
        siid: svc.siid,
        piid: prop.piid,
        name: prop.description,
        desc: ZH[prop.description] ?? prop.description,
        format: prop.format,
        access: prop.access,
      });
    }
    for (const act of svc.actions ?? []) {
      caps.push({
        kind: "action",
        siid: svc.siid,
        aiid: act.aiid,
        name: act.description,
        desc: ZH[act.description] ?? act.description,
      });
    }
  }
  return caps;
}

/** 从 home.miot-spec.com 拉取设备 spec（httpGet 注入以便测试） */
export async function fetchSpec(
  model: string,
  httpGet: (url: string) => Promise<unknown>,
): Promise<unknown> {
  return httpGet(`https://home.miot-spec.com/miot-spec-v2/instance?type=${encodeURIComponent(model)}`);
}
