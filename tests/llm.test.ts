import { beforeEach, describe, expect, it, vi } from "vitest";

/** 捕获 chat.completions.create 入参的 openai mock */
const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { OpenAICompatLLM } from "../src/agent/llm.js";
import type { ChatMessage, ToolDef } from "../src/agent/llm.js";

const tools: ToolDef[] = [
  {
    type: "function",
    function: { name: "control_device", description: "控制设备", parameters: { type: "object", properties: {} } },
  },
];

const makeLLM = () =>
  new OpenAICompatLLM({ baseUrl: "http://fake", apiKey: "k", model: "glm-4", timeoutMs: 1000 });

const assistantWithToolCalls: ChatMessage = {
  role: "assistant",
  content: "",
  tool_calls: [
    { id: "t1", name: "control_device", arguments: '{"device":"客厅主灯","action":"Switch Status","value":false}' },
  ],
};

describe("OpenAICompatLLM 线格式转换", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ choices: [{ message: { content: "ok", tool_calls: [] } }] });
  });

  it("带 toolCalls 的 assistant 消息映射为 OpenAI 嵌套线格式（content 显式 null）", async () => {
    const llm = makeLLM();
    await llm.chat(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "请关灯" },
        assistantWithToolCalls,
        { role: "tool", tool_call_id: "t1", content: "已执行" },
      ],
      tools,
    );
    const arg = createMock.mock.calls[0][0];
    expect(arg.messages[2]).toEqual({
      role: "assistant",
      content: null, // 部分 GLM 版本校验严，带 tool_calls 时 content 必须显式 null
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: {
            name: "control_device",
            arguments: '{"device":"客厅主灯","action":"Switch Status","value":false}',
          },
        },
      ],
    });
  });

  it("tool 消息保持 {role:'tool', tool_call_id, content} 形状", async () => {
    const llm = makeLLM();
    await llm.chat([assistantWithToolCalls, { role: "tool", tool_call_id: "t1", content: "已执行" }], tools);
    const arg = createMock.mock.calls[0][0];
    expect(arg.messages[1]).toEqual({ role: "tool", tool_call_id: "t1", content: "已执行" });
  });

  it("普通 system/user/assistant 消息不受影响", async () => {
    const llm = makeLLM();
    await llm.chat(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "在的" },
      ],
      tools,
    );
    const arg = createMock.mock.calls[0][0];
    expect(arg.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(arg.messages[1]).toEqual({ role: "user", content: "你好" });
    expect(arg.messages[2]).toEqual({ role: "assistant", content: "在的" });
  });

  it("响应侧 tool_calls 反向映射为扁平 {id,name,arguments}", async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "control_device", arguments: '{"device":"客厅主灯"}' } },
            ],
          },
        },
      ],
    });
    const llm = makeLLM();
    const reply = await llm.chat([{ role: "user", content: "开灯" }], tools);
    expect(reply.toolCalls).toEqual([
      { id: "tc1", name: "control_device", arguments: '{"device":"客厅主灯"}' },
    ]);
  });
});
