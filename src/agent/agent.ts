import type { DeviceInfo, IRemoteDevice } from "../types.js";
import type { ChatMessage, LLMClient, ToolCall } from "./llm.js";
import { buildToolDefs } from "./tools.js";

const MAX_TOOL_ROUNDS = 5;
const HISTORY_LIMIT = 8;
const FALLBACK_REPLY = "我脑子转不动了，稍后再试";

interface ToolResult {
  ok: boolean;
  message: string;
}

export interface AgentOptions {
  llm: LLMClient;
  devices: IRemoteDevice & {
    resolveDevice(nameOrDid: string): Promise<DeviceInfo | undefined>;
  };
  systemPrompt: () => string;
}

/** LLM 智能体：工具调用循环 + 内存对话历史 */
export class Agent {
  private history: ChatMessage[] = [];
  private readonly tools = buildToolDefs();

  constructor(private readonly opts: AgentOptions) {}

  async chat(userText: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.opts.systemPrompt() },
      ...this.history,
      { role: "user", content: userText },
    ];
    try {
      let reply = await this.opts.llm.chat(messages, this.tools);
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (reply.toolCalls.length === 0) {
          this.remember(userText, reply.content);
          return reply.content || FALLBACK_REPLY;
        }
        messages.push({
          role: "assistant",
          content: reply.content,
          tool_calls: reply.toolCalls,
        });
        for (const tc of reply.toolCalls) {
          const result = await this.runTool(tc);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.message });
        }
        reply = await this.opts.llm.chat(messages, this.tools);
      }
      this.remember(userText, "");
      return FALLBACK_REPLY;
    } catch (err) {
      return FALLBACK_REPLY; // 上层（speaker）负责播报兜底
    }
  }

  private remember(userText: string, assistantText: string): void {
    this.history.push({ role: "user", content: userText });
    if (assistantText) this.history.push({ role: "assistant", content: assistantText });
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
  }

  private async runTool(tc: ToolCall): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments || "{}");
    } catch {
      return { ok: false, message: `工具参数不是合法 JSON: ${tc.arguments}` };
    }
    const d = this.opts.devices;
    switch (tc.name) {
      case "list_devices": {
        const devices = await d.listDevices();
        const lines = devices.map((x) => `${x.name}（${x.model}）`);
        return { ok: true, message: lines.join("\n") || "家中暂无设备" };
      }
      case "get_device_state": {
        const name = String(args.device ?? "");
        const device = await d.resolveDevice(name);
        if (!device) return { ok: false, message: `未找到设备「${name}」，可用设备：${(await d.listDevices()).map((x) => x.name).join("、")}` };
        const state = await d.getDeviceState(device.did);
        return { ok: true, message: JSON.stringify(state.properties) };
      }
      case "control_device": {
        const name = String(args.device ?? "");
        const device = await d.resolveDevice(name);
        if (!device) return { ok: false, message: `未找到设备「${name}」，可用设备：${(await d.listDevices()).map((x) => x.name).join("、")}` };
        return d.executeAction(device.did, String(args.action ?? ""), args.value);
      }
      default:
        return { ok: false, message: `未知工具: ${tc.name}` };
    }
  }
}
