import { describe, it, expect } from "vitest";
import {
  responseToStreamChunks,
  assembleStreamedResponse,
  sseFrame,
  SSE_DONE,
} from "../../src/util/sse.js";
import type { ChatCompletionResponse } from "../../src/types/openai.js";

function completion(content: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };
}

describe("responseToStreamChunks", () => {
  it("emits an opening role chunk, content chunks, and a terminal finish chunk", () => {
    const chunks = [...responseToStreamChunks(completion("hello world"), { includeUsage: false })];
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0]!.finish_reason).toBe("stop");
  });

  it("omits the usage-only chunk unless requested", () => {
    const without = [...responseToStreamChunks(completion("hi"), { includeUsage: false })];
    expect(without.some((c) => c.usage != null)).toBe(false);

    const withUsage = [...responseToStreamChunks(completion("hi"), { includeUsage: true })];
    const usageChunk = withUsage.find((c) => c.choices.length === 0 && c.usage != null);
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  });

  it("round-trips: chunks reassemble into the original text", () => {
    const original = completion("The quick brown fox jumps");
    const chunks = [...responseToStreamChunks(original, { includeUsage: true })];
    const rebuilt = assembleStreamedResponse(chunks, "fallback-model");
    expect(rebuilt.choices[0]!.message.content).toBe("The quick brown fox jumps");
    expect(rebuilt.usage).toEqual(original.usage);
    expect(rebuilt.choices[0]!.finish_reason).toBe("stop");
  });
});

describe("assembleStreamedResponse", () => {
  it("uses the fallback model when no chunk carries one", () => {
    const rebuilt = assembleStreamedResponse([], "fallback-model");
    expect(rebuilt.model).toBe("fallback-model");
    expect(rebuilt.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe("sseFrame", () => {
  it("formats a data frame terminated by a blank line", () => {
    expect(sseFrame({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it("exposes the standard DONE sentinel", () => {
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});
