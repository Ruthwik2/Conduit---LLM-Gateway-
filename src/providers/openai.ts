import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../types/openai.js";
import type { ProviderResult } from "../types/internal.js";
import { classifyProviderError } from "./errors.js";
import type { ChatProvider, ProviderCallContext } from "./provider.js";

export interface OpenAIProviderOptions {
  name: string;
  apiKey: string;
  /** Override for OpenAI-compatible servers (Azure, vLLM, Together, etc.). */
  baseURL?: string;
  vendor?: string;
}

/**
 * Adapter for OpenAI and any OpenAI-compatible endpoint. Because Conduit's wire
 * format *is* OpenAI's, this adapter is close to a pass-through: the request and
 * response objects already match. The work it does is (a) remapping the model
 * id, (b) forcing `include_usage` on streams so accounting is always exact, and
 * (c) translating SDK errors into the router's failure vocabulary.
 */
export class OpenAIProvider implements ChatProvider {
  readonly name: string;
  readonly vendor: string;
  private client: OpenAI;

  constructor(opts: OpenAIProviderOptions) {
    this.name = opts.name;
    this.vendor = opts.vendor ?? "openai";
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: 0, // Conduit owns retry/failover policy, not the SDK.
    });
  }

  async complete(req: ChatCompletionRequest, ctx: ProviderCallContext): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const params = {
        ...req,
        model: ctx.upstreamModel,
        stream: false,
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

      const completion = await this.client.chat.completions.create(params, {
        signal: ctx.signal,
        timeout: ctx.timeoutMs,
      });

      // The SDK response is already in OpenAI wire format — identical to ours.
      return { response: completion as unknown as ProviderResult["response"], latencyMs: performance.now() - start };
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }
  }

  async *stream(req: ChatCompletionRequest, ctx: ProviderCallContext): AsyncIterable<ChatCompletionChunk> {
    try {
      const params = {
        ...req,
        model: ctx.upstreamModel,
        stream: true,
        // Always ask upstream for usage so we can meter streamed calls precisely.
        stream_options: { include_usage: true },
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

      const stream = await this.client.chat.completions.create(params, {
        signal: ctx.signal,
        timeout: ctx.timeoutMs,
      });

      for await (const chunk of stream) {
        yield chunk as unknown as ChatCompletionChunk;
      }
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }
  }
}
