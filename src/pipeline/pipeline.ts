import type { Logger } from "../telemetry/logger.js";
import type { Metrics } from "../telemetry/metrics.js";
import type { CacheLookup, CacheService } from "../cache/cache.js";
import type { KeyStore } from "../auth/key-store.js";
import { authenticate } from "../auth/key-store.js";
import { keyAllowsModel, type VirtualKey } from "../auth/virtual-key.js";
import type { RateLimiter } from "../governance/rate-limit.js";
import { enforceBudget, type BudgetStore } from "../governance/budget.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Router } from "../router/router.js";
import { computeCost } from "../accounting/pricing.js";
import type { UsageAggregator } from "../accounting/usage.js";
import {
  ConduitError,
  ForbiddenModelError,
  NoRouteError,
  RateLimitError,
} from "../util/errors.js";
import { requestLogger } from "../telemetry/logger.js";
import {
  assembleStreamedResponse,
  responseToStreamChunks,
  sseFrame,
  SSE_DONE,
} from "../util/sse.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../types/openai.js";
import type { ServeOutcome } from "../types/internal.js";

export interface PipelineDeps {
  keys: KeyStore;
  rateLimiter: RateLimiter;
  budget: BudgetStore;
  cache: CacheService;
  registry: ProviderRegistry;
  router: Router;
  usage: UsageAggregator;
  metrics?: Metrics;
  logger: Logger;
}

export interface RequestCtx {
  requestId: string;
  secret: string | undefined;
  clientSignal?: AbortSignal;
}

export interface CompleteResult {
  response: ChatCompletionResponse;
  outcome: ServeOutcome;
  provider: string | null;
  keyId: string;
}

const ZERO_USAGE: ChatCompletionResponse["usage"] = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

/**
 * The heart of Conduit: it runs every request through the same governed
 * lifecycle —
 *
 *   1. authenticate the virtual key
 *   2. enforce model allowlist, rate limit, and budget
 *   3. consult the cache (exact, then semantic)
 *   4. on a miss, route to a provider with health-aware failover
 *   5. stream/return the answer
 *   6. record usage, cost, latency, and cache outcome
 *
 * Non-streaming and streaming share steps 1–2 (`admit`) and step 6
 * (`account`), so governance and metrics behave identically regardless of
 * transport.
 *
 * Failure philosophy: governance gates (steps 1–2) fail CLOSED — if we cannot
 * verify a key, a rate limit, or a budget, the request is rejected. The cache
 * (step 3) fails OPEN — it is an optimization, and a Redis/pgvector/embeddings
 * outage degrades to cache misses rather than taking the data path down.
 * Accounting (step 6) is non-fatal — it never fails a request that has already
 * been answered; failures are logged loudly instead.
 */
export class Pipeline {
  constructor(private deps: PipelineDeps) {}

  /** Steps 1–2. Returns the authenticated key or throws a ConduitError. */
  private async admit(req: ChatCompletionRequest, ctx: RequestCtx): Promise<VirtualKey> {
    const key = await authenticate(this.deps.keys, ctx.secret);

    if (!keyAllowsModel(key, req.model)) {
      throw new ForbiddenModelError(req.model);
    }

    const decision = await this.deps.rateLimiter.check(key.id, key.rateLimit);
    if (!decision.allowed) {
      throw new RateLimitError(Math.ceil(decision.retryAfterMs / 1000));
    }

    await enforceBudget(this.deps.budget, key);

    // Fail fast if no provider is configured for this model.
    if (!this.deps.registry.resolveRoute(req.model)) {
      throw new NoRouteError(req.model);
    }

    return key;
  }

  /**
   * Step 6. Fan usage out to budget, aggregator, and metrics. Never throws:
   * by the time this runs the answer has been produced (and the provider call
   * paid for), so an accounting-backend blip must not turn a served request
   * into a caller-facing failure. Enforcement at admit time still fails closed;
   * the risk here is under-counting, which we surface loudly for operators.
   */
  private async account(
    req: ChatCompletionRequest,
    key: VirtualKey,
    args: {
      requestId: string;
      outcome: ServeOutcome;
      provider: string | null;
      usage: ChatCompletionResponse["usage"];
      durationMs: number;
      status: number;
    },
  ): Promise<void> {
    try {
      // A cache hit skipped the provider, so its marginal cost is zero — this is
      // exactly how the cache "reduces spend".
      const costUsd = args.outcome === "provider" ? computeCost(req.model, args.usage) : 0;
      if (costUsd > 0) await this.deps.budget.addSpend(key.id, costUsd);

      this.deps.usage.record({
        requestId: args.requestId,
        keyId: key.id,
        model: req.model,
        provider: args.provider,
        outcome: args.outcome,
        usage: args.usage,
        costUsd,
        latencyMs: args.durationMs,
        status: args.status,
      });

      this.deps.metrics?.recordRequest({
        keyId: key.id,
        model: req.model,
        provider: args.provider,
        outcome: args.outcome,
        status: args.status,
        durationMs: args.durationMs,
        usage: args.usage,
        costUsd,
      });
    } catch (err) {
      this.deps.logger.error(
        { err, requestId: args.requestId, keyId: key.id, model: req.model },
        "usage accounting failed (request already served; spend may be under-counted)",
      );
    }
  }

  /** Non-streaming path. */
  async complete(req: ChatCompletionRequest, ctx: RequestCtx): Promise<CompleteResult> {
    const start = performance.now();
    const key = await this.admit(req, ctx);
    const log = requestLogger(this.deps.logger, { requestId: ctx.requestId, keyId: key.id });

    // Step 3: cache (fail-open — see safeLookup).
    const cached = await this.safeLookup(req, key.id, log);
    if (cached) {
      const durationMs = performance.now() - start;
      await this.account(req, key, {
        requestId: ctx.requestId,
        outcome: cached.outcome,
        provider: null,
        usage: cached.response.usage,
        durationMs,
        status: 200,
      });
      log.info(
        { outcome: cached.outcome, similarity: cached.similarity, durationMs: Math.round(durationMs) },
        "served from cache",
      );
      return { response: cached.response, outcome: cached.outcome, provider: null, keyId: key.id };
    }

    // Steps 4–5: route with failover.
    const plan = this.deps.registry.resolveRoute(req.model)!;
    let routed: Awaited<ReturnType<Router["complete"]>>;
    try {
      routed = await this.deps.router.complete(req, plan, {
        requestId: ctx.requestId,
        clientSignal: ctx.clientSignal,
      });
    } catch (err) {
      // Record the failed request so error rates are visible in
      // conduit_requests_total, mirroring the streaming path. No usage, no cost.
      const durationMs = performance.now() - start;
      const status = err instanceof ConduitError ? err.status : 500;
      await this.account(req, key, {
        requestId: ctx.requestId,
        outcome: "provider",
        provider: null,
        usage: ZERO_USAGE,
        durationMs,
        status,
      });
      throw err;
    }
    const { result, provider } = routed;

    // Step 6 + cache write.
    const durationMs = performance.now() - start;
    await this.account(req, key, {
      requestId: ctx.requestId,
      outcome: "provider",
      provider,
      usage: result.response.usage,
      durationMs,
      status: 200,
    });
    void this.safeStore(req, result.response, key.id, log);

    log.info(
      { provider, durationMs: Math.round(durationMs), tokens: result.response.usage.total_tokens },
      "served from provider",
    );
    return { response: result.response, outcome: "provider", provider, keyId: key.id };
  }

  /**
   * Streaming path. Yields ready-to-write SSE frames (including the terminal
   * `[DONE]`). A cache hit is replayed as a synthetic stream the client can't
   * distinguish from a live one.
   *
   * Accounting is guaranteed: the provider loop runs inside try/finally, so a
   * stream that ends early — the client disconnected (this generator is
   * `return()`ed / the abort signal fired) or the provider died mid-stream —
   * is still recorded, with status 499 (client closed request) or 502, and
   * whatever usage the provider managed to report is billed. Partial answers
   * are never written to the cache.
   */
  async *stream(req: ChatCompletionRequest, ctx: RequestCtx): AsyncGenerator<string> {
    const start = performance.now();
    const key = await this.admit(req, ctx);
    const log = requestLogger(this.deps.logger, { requestId: ctx.requestId, keyId: key.id });
    const wantUsage = Boolean(req.stream_options?.include_usage);

    // Step 3: cache → replay (fail-open — see safeLookup).
    const cached = await this.safeLookup(req, key.id, log);
    if (cached) {
      for (const chunk of responseToStreamChunks(cached.response, { includeUsage: wantUsage })) {
        yield sseFrame(chunk);
      }
      yield SSE_DONE;
      const durationMs = performance.now() - start;
      await this.account(req, key, {
        requestId: ctx.requestId,
        outcome: cached.outcome,
        provider: null,
        usage: cached.response.usage,
        durationMs,
        status: 200,
      });
      log.info({ outcome: cached.outcome, similarity: cached.similarity }, "streamed from cache");
      return;
    }

    // Steps 4–5: stream from a provider with pre-first-byte failover.
    const plan = this.deps.registry.resolveRoute(req.model)!;
    const received: ChatCompletionChunk[] = [];
    let provider: string | null = null;
    let completed = false;

    try {
      for await (const ev of this.deps.router.stream(req, plan, {
        requestId: ctx.requestId,
        clientSignal: ctx.clientSignal,
      })) {
        provider = ev.provider;
        received.push(ev.chunk);

        // The adapters force usage reporting upstream; if the client didn't ask
        // for it, swallow the usage-only chunk but still keep it for accounting.
        const isUsageOnly = ev.chunk.choices.length === 0 && ev.chunk.usage != null;
        if (isUsageOnly && !wantUsage) continue;

        yield sseFrame(ev.chunk);
      }
      yield SSE_DONE;
      completed = true;
    } finally {
      // Step 6 — always runs, even when the consumer stops early.
      const assembled = assembleStreamedResponse(received, req.model);
      const durationMs = performance.now() - start;
      const status = completed ? 200 : ctx.clientSignal?.aborted ? 499 : 502;
      await this.account(req, key, {
        requestId: ctx.requestId,
        outcome: "provider",
        provider,
        usage: assembled.usage,
        durationMs,
        status,
      });

      if (completed) {
        void this.safeStore(req, assembled, key.id, log);
        log.info(
          { provider, durationMs: Math.round(durationMs), tokens: assembled.usage.total_tokens },
          "streamed from provider",
        );
      } else {
        log.warn(
          { provider, durationMs: Math.round(durationMs), status, chunks: received.length },
          "stream ended before completion; partial usage recorded",
        );
      }
    }
  }

  /**
   * Cache reads fail OPEN: the cache is an optimization, and its backends
   * (Redis, pgvector, an embeddings API) going down must never take the data
   * path with them. An error is logged + counted and treated as a miss, so the
   * request proceeds to a provider as if the cache were cold.
   */
  private async safeLookup(
    req: ChatCompletionRequest,
    keyId: string,
    log: Logger,
  ): Promise<CacheLookup | null> {
    try {
      return await this.deps.cache.lookup(req, keyId);
    } catch (err) {
      this.deps.metrics?.cacheError("lookup");
      log.warn({ err }, "cache lookup failed (fail-open: treating as a miss)");
      return null;
    }
  }

  /** Cache writes must never fail a request that already succeeded. */
  private async safeStore(
    req: ChatCompletionRequest,
    response: ChatCompletionResponse,
    keyId: string,
    log: Logger,
  ): Promise<void> {
    try {
      await this.deps.cache.store(req, response, keyId);
    } catch (err) {
      this.deps.metrics?.cacheError("store");
      log.warn({ err }, "cache write failed (ignored)");
    }
  }
}
