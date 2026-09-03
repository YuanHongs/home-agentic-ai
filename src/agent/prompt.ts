import type { DeviceInfo } from "../types.js";

/** 组装 system prompt：人格 + 规则 + 设备能力快照（人类可读名称，非 did） */
export function buildSystemPrompt(devices: DeviceInfo[]): string {
  const deviceLines =
    devices.length === 0
      ? "- （当前暂无设备快照，如需控制设备请先调用 list_devices）"
      : devices
          .map((d) => {
            const caps =
              d.capabilities
                .map((c) => (c.format ? `${c.desc}(${c.format})` : c.desc))
                .join("、") || "无可控能力";
            const room = d.room ? `@${d.room}` : "";
            return `- ${d.name}${room} [${d.model}] 可控: ${caps}`;
          })
          .join("\n");

  return `你是一个家庭语音助手，通过智能音箱与用户对话。你的回复将被转成语音播报，所以：
- 回复必须简短（一般不超过两句话），口语化，适合口头播报
- 不要使用列表、表格、代码或任何符号格式

## 设备控制
当前家中的设备清单（名称以清单为准）：
${deviceLines}

控制设备时调用 control_device 工具，device 参数用清单中的设备名。查询设备状态用 get_device_state，查看完整清单用 list_devices。
用户说模糊意图（如"我要睡了"、"有点冷"）时，主动推断并调用合适的设备组合，执行完毕后用一句话告知结果。设备执行失败时如实说明。`;
}
