import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from "../types/openai.js";
import type { ProviderResult } from "../types/internal.js";
import { chatCompletionId, unixSeconds } from "../util/id.js";
import { classifyProviderError } from "./errors.js";
import type { ChatProvider, ProviderCallContext } from "./provider.js";

export interface AnthropicProviderOptions {
  name: string;
  apiKey: string;
  baseURL?: string;
  /** Anthropic requires max_tokens; used when the caller omits it. */
  defaultMaxTokens?: number;
}

/**
 * Adapter for Anthropic's Messages API. Unlike the OpenAI adapter, this one
 * does genuine protocol translation in both directions:
 *
 *   OpenAI request  ──▶  Anthropic MessageCreateParams
 *   Anthropic reply ──▶  OpenAI chat.completion / chat.completion.chunk
 *
 * That translation (system-message hoisting, role mapping, stop-reason mapping,
 * SSE event re-shaping, usage extraction) is the proof that the Provider
 * abstraction is real and not OpenAI-shaped under the hood.
 */
export class AnthropicProvider implements ChatProvider {
  readonly vendor = "anthropic";
  readonly name: string;
  private client: Anthropic;
  private defaultMaxTokens: number;

  constructor(opts: AnthropicProviderOptions) {
    this.name = opts.name;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: 0,
    });
  }

  async complete(req: ChatCompletionRequest, ctx: ProviderCallContext): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const params = this.toAnthropicParams(req, ctx.upstreamModel);
      const msg = await this.client.messages.create(
        { ...params, stream: false },
        { signal: ctx.signal, timeout: ctx.timeoutMs },
      );

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const response: ChatCompletionResponse = {
        id: chatCompletionId(),
        object: "chat.completion",
        created: unixSeconds(),
        model: ctx.upstreamModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: mapStopReason(msg.stop_reason),
          },
        ],
        usage: {
          prompt_tokens: msg.usage.input_tokens,
          completion_tokens: msg.usage.output_tokens,
          total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
        },
      };
      return { response, latencyMs: performance.now() - start };
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }
  }

  async *stream(req: ChatCompletionRequest, ctx: ProviderCallContext): AsyncIterable<ChatCompletionChunk> {
    const id = chatCompletionId();
    const created = unixSeconds();
    const base = { id, object: "chat.completion.chunk" as const, created, model: ctx.upstreamModel };

    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const params = this.toAnthropicParams(req, ctx.upstreamModel);
      const stream = this.client.messages.stream(params, {
        signal: ctx.signal,
        timeout: ctx.timeoutMs,
      });

      for await (const event of stream) {
        switch (event.type) {
          case "message_start": {
            promptTokens = event.message.usage.input_tokens;
            yield { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
            break;
          }
          case "content_block_delta": {
            if (event.delta.type === "text_delta" && event.delta.text) {
              yield { ...base, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] };
            }
            break;
          }
          case "message_delta": {
            completionTokens = event.usage.output_tokens;
            const finish = mapStopReason(event.delta.stop_reason ?? null);
            yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
            break;
          }
          default:
            break; // content_block_start / _stop / message_stop / ping — nothing to forward
        }
      }

      // Final usage chunk, mirroring OpenAI's `stream_options.include_usage`.
      yield {
        ...base,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }
  }

  private toAnthropicParams(
    req: ChatCompletionRequest,
    model: string,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const system = req.messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => extractText(m.content))
      .filter(Boolean)
      .join("\n\n");

    const messages: Anthropic.MessageParam[] = req.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "function")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.role === "tool" || m.role === "function"
          ? `[tool result] ${extractText(m.content)}`
          : extractText(m.content),
      }));

    const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? this.defaultMaxTokens;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      messages,
    };
    if (system) params.system = system;
    if (typeof req.temperature === "number") params.temperature = Math.min(req.temperature, 1);
    if (typeof req.top_p === "number") params.top_p = req.top_p;
    if (req.stop) params.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    return params;
  }
}

function mapStopReason(
  reason: Anthropic.Message["stop_reason"] | null,
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

function extractText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
        return "";
      })
      .join("");
  }
  return "";
}
