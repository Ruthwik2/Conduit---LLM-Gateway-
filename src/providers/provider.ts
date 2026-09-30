import type { ChatCompletionChunk, ChatCompletionRequest } from "../types/openai.js";
import type { ProviderResult } from "../types/internal.js";

/** Per-call context handed to a provider adapter. */
export interface ProviderCallContext {
  /** The model id to send upstream (config may remap the caller's model). */
  upstreamModel: string;
  /** Abort signal — fires on timeout or when the downstream client disconnects. */
  signal: AbortSignal;
  /** Hard timeout for the upstream call, milliseconds. */
  timeoutMs: number;
  requestId: string;
}

/**
 * The single abstraction the rest of Conduit programs against. Adding a new
 * vendor is exactly: implement this interface. The router, cache, accounting,
 * and governance layers never learn a provider's name.
 */
export interface ChatProvider {
  /** Instance name from config, e.g. "openai-primary" or "anthropic-fallback". */
  readonly name: string;

  /** Vendor family, used for pricing lookups and logs, e.g. "openai". */
  readonly vendor: string;

  /** Non-streaming completion. Throws {@link ProviderError} on failure. */
  complete(req: ChatCompletionRequest, ctx: ProviderCallContext): Promise<ProviderResult>;

  /**
   * Streaming completion. Yields chunks already normalized to OpenAI's
   * `chat.completion.chunk` shape. The final chunk(s) carry `usage` so the
   * pipeline can do exact accounting even for streamed calls.
   */
  stream(
    req: ChatCompletionRequest,
    ctx: ProviderCallContext,
  ): AsyncIterable<ChatCompletionChunk>;
}
