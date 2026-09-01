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
      // OpenAI SDK 不接受 role/tool_calls 的自有子集类型，这里在边界处做一次结构兼容断言
      messages: messages.map((m) => ({ ...m, content: m.content || undefined })) as unknown as OpenAI.ChatCompletionMessageParam[],
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
