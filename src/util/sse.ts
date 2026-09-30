import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../types/openai.js";
import { unixSeconds } from "./id.js";

export const SSE_DONE = "data: [DONE]\n\n";

/** Format an OpenAI chunk object as an SSE `data:` frame. */
export function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Turn a complete (non-streamed) chat completion into a sequence of streaming
 * chunks. Used to replay a *cached* answer to a client that asked for
 * `stream: true` — the client cannot tell the difference from a live stream.
 *
 * We chunk the assistant text on word boundaries so the replay looks natural
 * and the first byte arrives immediately.
 */
export function* responseToStreamChunks(
  response: ChatCompletionResponse,
  opts: { includeUsage: boolean },
): Generator<ChatCompletionChunk> {
  const created = unixSeconds();
  const base = { id: response.id, model: response.model, created };
  const choice = response.choices[0];
  const content = choice?.message.content ?? "";
  const finish = choice?.finish_reason ?? "stop";

  // Opening chunk: announce the assistant role.
  yield {
    ...base,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  };

  // Content chunks, split on whitespace but keeping the separators.
  const pieces = content.match(/\S+\s*/g) ?? [];
  for (const piece of pieces) {
    yield {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
  }

  // Terminal chunk with finish_reason.
  yield {
    ...base,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  };

  if (opts.includeUsage) {
    yield {
      ...base,
      object: "chat.completion.chunk",
      choices: [],
      usage: response.usage,
    };
  }
}

/**
 * Reassemble a streamed sequence of chunks back into a single completion
 * object. Used to (a) populate the cache after a streamed upstream call and
 * (b) compute usage when a provider only reports it at the end.
 */
export function assembleStreamedResponse(
  chunks: ChatCompletionChunk[],
  fallbackModel: string,
): ChatCompletionResponse {
  let content = "";
  let finish: ChatCompletionResponse["choices"][number]["finish_reason"] = null;
  let id = "";
  let model = fallbackModel;
  let usage: ChatCompletionResponse["usage"] | undefined;

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    const choice = chunk.choices[0];
    if (choice?.delta.content) content += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  return {
    id: id || fallbackModel,
    object: "chat.completion",
    created: unixSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finish ?? "stop",
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
