import OpenAI from "openai";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串形式的参数 */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LLMReply {
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface LLMClient {
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMReply>;
}

/** 内部消息 → OpenAI 线格式（出站边界转换） */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls?.length) {
    return {
      role: "assistant",
      content: null, // 部分 GLM 版本对带 tool_calls 的 assistant 校验 content 必须显式 null
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content || undefined };
}

/** OpenAI 兼容端点适配（GLM/DeepSeek/Kimi/Qwen 等） */
export class OpenAICompatLLM implements LLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }) {
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      maxRetries: 1,
    });
    this.model = opts.model;
  }

  async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LLMReply> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      // 内部扁平 ToolCall 在出站边界转为 OpenAI 线格式：
      // assistant 的 tool_calls 需嵌套为 {id, type, function:{name, arguments}}，
      // 且带 tool_calls 时 content 显式 null（部分 GLM 版本校验严）
      messages: messages.map(toWireMessage) as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: tools as unknown as OpenAI.ChatCompletionTool[],
    });
    const choice = res.choices[0]?.message;
    return {
      content: choice?.content ?? "",
      toolCalls: (choice?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
    };
  }
}
