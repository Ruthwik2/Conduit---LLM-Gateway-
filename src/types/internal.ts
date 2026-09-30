import type { ChatCompletionRequest, ChatCompletionResponse, TokenUsage } from "./openai.js";

/** How a request was ultimately served. Drives metrics + response headers. */
export type ServeOutcome =
  | "provider" // went upstream to a provider
  | "cache_exact" // served from the exact-match cache
  | "cache_semantic"; // served from the semantic cache

/** Classification of a provider failure, used by the router + circuit breaker. */
export type FailureKind =
  | "timeout"
  | "rate_limit" // 429 from upstream
  | "server_error" // 5xx from upstream
  | "connection" // network / DNS / socket
  | "client_error" // 4xx that is the caller's fault — do NOT fail over
  | "unknown";

export interface ProviderUsage extends TokenUsage {}

/** Non-streaming result returned by a provider adapter. */
export interface ProviderResult {
  response: ChatCompletionResponse;
  /** Wall-clock latency of the upstream call, milliseconds. */
  latencyMs: number;
}

/** A single streamed chunk from a provider, already normalized to OpenAI shape. */
export interface ProviderStreamEvent {
  /** Raw SSE `data:` payload (an OpenAI-format chunk object). */
  chunk: import("./openai.js").ChatCompletionChunk;
}

/** Resolved per-model routing plan from config. */
export interface RoutePlan {
  /** The model id the caller asked for. */
  model: string;
  /** Ordered provider attempts: primary first, then fallbacks. */
  targets: RouteTarget[];
}

export interface RouteTarget {
  /** Provider instance name, e.g. "openai-primary". */
  provider: string;
  /** The model id to send to *that* provider (may differ from caller's). */
  upstreamModel: string;
}

/** Everything we know about a request as it moves through the pipeline. */
export interface RequestContext {
  requestId: string;
  receivedAt: number;
  body: ChatCompletionRequest;
  stream: boolean;
  /** Authenticated virtual key (id only; secret never travels past auth). */
  keyId: string;
  keyName: string;
}

export interface UsageRecord {
  requestId: string;
  keyId: string;
  model: string;
  provider: string | null;
  outcome: ServeOutcome;
  usage: ProviderUsage;
  costUsd: number;
  latencyMs: number;
  status: number;
}
