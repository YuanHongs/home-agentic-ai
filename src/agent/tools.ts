import type { ToolDef } from "./llm.js";

export function buildToolDefs(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "list_devices",
        description: "列出家中所有智能设备及其可控能力",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_device_state",
        description: "查询某台设备的当前状态（如开关、亮度、温度）",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备名称" },
          },
          required: ["device"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "control_device",
        description: "控制一台设备。action 为能力名（如 On/Brightness），value 为目标值",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备名称" },
            action: { type: "string", description: "能力名，如 On" },
            value: { description: "目标值：bool/数字/字符串，action 类能力可省略" },
          },
          required: ["device", "action"],
        },
      },
    },
  ];
}
