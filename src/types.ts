/** 设备能力（来自 MIoT spec） */
export interface DeviceCapability {
  kind: "property" | "action";
  /** MIoT spec 服务 ID */
  siid: number;
  /** 属性 ID（kind=property 时存在） */
  piid?: number;
  /** 动作 ID（kind=action 时存在） */
  aiid?: number;
  /** spec 规范名，如 On / Brightness / Play，作为 LLM 调用的能力标识 */
  name: string;
  /** 中文人话描述，如 "开关" / "亮度(0-100)" */
  desc: string;
  /** property 的值格式：bool / uint8 / string ... */
  format?: string;
  /** property 的访问权限 */
  access?: string[];
  /** property 的数值范围（来自 spec 的 value-range [min,max,step]，step 丢弃） */
  constraint?: { min?: number; max?: number };
  /** property 的枚举取值列表（来自 spec 的 value-list，取每项的 value 字段） */
  values?: unknown[];
}

export interface DeviceInfo {
  did: string;
  /** 米家里的人类可读名称，如 "客厅主灯" */
  name: string;
  /** 设备型号，如 "philips.light.bulb" */
  model: string;
  room?: string;
  /** MIoT spec URN 第 4 段的设备类型（如 light / lock）；无 spec 时缺省 */
  deviceType?: string;
  capabilities: DeviceCapability[];
}

export interface DeviceState {
  did: string;
  /** 能力名 -> 当前值，如 { On: true, Brightness: 80 } */
  properties: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** 智能体层看到的设备抽象——不感知小米协议 */
export interface IRemoteDevice {
  listDevices(): Promise<DeviceInfo[]>;
  getDeviceState(did: string): Promise<DeviceState>;
  executeAction(did: string, capability: string, value?: unknown): Promise<ActionResult>;
}

/** 小爱对话记录（已过滤） */
export interface ConversationRecord {
  text: string;
  /** 毫秒时间戳 */
  timestamp: number;
}
