import type { RouterConfig } from "../config/schema.js";
import { ProviderError, classifyProviderError } from "../providers/errors.js";
import type { ChatProvider } from "../providers/provider.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../types/openai.js";
import type { ProviderResult, RoutePlan } from "../types/internal.js";
import { ClientDisconnectedError, ConduitError, UpstreamUnavailableError } from "../util/errors.js";
import { computeBackoffMs, sleep } from "./backoff.js";
import type { CircuitBreakerRegistry } from "./circuit-breaker.js";

/** Optional metrics sink; the router stays decoupled from prom-client. */
export interface RouterMetrics {
  providerCall(provider: string, outcome: "success" | "failure", kind?: string): void;
  circuitRejection(provider: string): void;
}

export interface RouterCallOptions {
  requestId: string;
  /** Fires when the downstream client disconnects; cancels the upstream call. */
  clientSignal?: AbortSignal;
}

export interface CompleteOutcome {
  result: ProviderResult;
  provider: string;
}

export interface StreamChunk {
  chunk: ChatCompletionChunk;
  provider: string;
}

/** Thrown inside the stream path to carry whether failover is still possible. */
class StreamAttemptError extends Error {
  constructor(
    readonly providerError: ProviderError,
    /** True only if no chunk was forwarded yet (so we may try another provider). */
    readonly recoverable: boolean,
    /** The abort came from the downstream client, not the provider. */
    readonly clientAborted = false,
  ) {
    super(providerError.message);
  }
}

export class Router {
  constructor(
    private registry: ProviderRegistry,
    private cfg: RouterConfig,
    private circuits: CircuitBreakerRegistry,
    private metrics?: RouterMetrics,
  ) {}

  /**
   * Non-streaming completion with health-aware failover. Walks the target list;
   * for each healthy provider it tries up to `retriesPerTarget + 1` times with
   * backoff, then moves on. A caller-fault (4xx) short-circuits the whole walk —
   * other providers would only reproduce the same rejection.
   */
  async complete(
    req: ChatCompletionRequest,
    plan: RoutePlan,
    opts: RouterCallOptions,
  ): Promise<CompleteOutcome> {
    const failures: string[] = [];

    for (const target of plan.targets) {
      const provider = this.registry.getProvider(target.provider);
      if (!provider) {
        failures.push(`${target.provider}: not registered`);
        continue;
      }
      const breaker = this.circuits.get(target.provider);
      if (!breaker.allowRequest()) {
        this.metrics?.circuitRejection(target.provider);
        failures.push(`${target.provider}: circuit ${breaker.getState()}`);
        continue;
      }

      let attempt = 0;
      while (true) {
        const actx = this.attemptContext(opts);
        try {
          const result = await provider.complete(req, {
            upstreamModel: target.upstreamModel,
            signal: actx.signal,
            timeoutMs: this.cfg.timeoutMs,
            requestId: opts.requestId,
          });
          breaker.onSuccess(result.latencyMs);
          this.metrics?.providerCall(target.provider, "success");
          return { result, provider: target.provider };
        } catch (err) {
          // The downstream client hung up: the abort we see is *ours*, not a
          // provider fault. Don't touch breaker health or failure metrics, and
          // don't fail over — nobody is left to receive an answer.
          if (opts.clientSignal?.aborted) throw new ClientDisconnectedError();

          const pe = classifyProviderError(err, target.provider);
          if (pe.countsAgainstHealth) breaker.onFailure();
          this.metrics?.providerCall(target.provider, "failure", pe.kind);
          failures.push(`${target.provider}: ${pe.message}`);

          if (pe.kind === "client_error") throw surfaceClientError(pe);
          if (attempt < this.cfg.retriesPerTarget && pe.retriable) {
            await sleep(computeBackoffMs(attempt, this.cfg.backoff), opts.clientSignal);
            attempt++;
            continue;
          }
          break; // exhausted this target → next target
        } finally {
          actx.dispose();
        }
      }
    }

    throw new UpstreamUnavailableError(plan.model, failures.join("; "));
  }

  /**
   * Streaming completion with failover *up to the first byte*. Once a chunk has
   * been forwarded we are committed to that provider — switching mid-stream
   * would corrupt the client's view — so a later error is surfaced, not retried.
   */
  async *stream(
    req: ChatCompletionRequest,
    plan: RoutePlan,
    opts: RouterCallOptions,
  ): AsyncGenerator<StreamChunk> {
    const failures: string[] = [];

    for (const target of plan.targets) {
      const provider = this.registry.getProvider(target.provider);
      if (!provider) {
        failures.push(`${target.provider}: not registered`);
        continue;
      }
      const breaker = this.circuits.get(target.provider);
      if (!breaker.allowRequest()) {
        this.metrics?.circuitRejection(target.provider);
        failures.push(`${target.provider}: circuit ${breaker.getState()}`);
        continue;
      }

      let attempt = 0;
      while (true) {
        try {
          yield* this.attemptStream(provider, target, req, opts);
          this.metrics?.providerCall(target.provider, "success");
          return; // streamed to completion
        } catch (e) {
          const sae = e as StreamAttemptError;
          if (sae.clientAborted) throw new ClientDisconnectedError();

          const pe = sae.providerError;
          this.metrics?.providerCall(target.provider, "failure", pe.kind);
          failures.push(`${target.provider}: ${pe.message}`);

          if (!sae.recoverable) throw surfaceMidStream(pe); // bytes already sent
          if (pe.kind === "client_error") throw surfaceClientError(pe);
          if (attempt < this.cfg.retriesPerTarget && pe.retriable) {
            await sleep(computeBackoffMs(attempt, this.cfg.backoff), opts.clientSignal);
            attempt++;
            continue;
          }
          break; // next target
        }
      }
    }

    throw new UpstreamUnavailableError(plan.model, failures.join("; "));
  }

  private async *attemptStream(
    provider: ChatProvider,
    target: RoutePlan["targets"][number],
    req: ChatCompletionRequest,
    opts: RouterCallOptions,
  ): AsyncGenerator<StreamChunk> {
    const breaker = this.circuits.get(target.provider);
    const actx = this.attemptContext(opts);
    const start = performance.now();
    let yieldedAny = false;
    try {
      for await (const chunk of provider.stream(req, {
        upstreamModel: target.upstreamModel,
        signal: actx.signal,
        timeoutMs: this.cfg.timeoutMs,
        requestId: opts.requestId,
      })) {
        if (!yieldedAny) {
          // First byte arrived: the "unresponsive provider" timeout has done
          // its job. Long generations must not be killed by a total-duration
          // cap; from here the client signal and the provider govern lifetime.
          actx.startedStreaming();
          yieldedAny = true;
        }
        yield { chunk, provider: target.provider };
      }
      breaker.onSuccess(performance.now() - start);
    } catch (err) {
      const pe = classifyProviderError(err, target.provider);
      if (opts.clientSignal?.aborted) {
        // Client-initiated abort: never a health event for the provider.
        throw new StreamAttemptError(pe, false, true);
      }
      if (pe.countsAgainstHealth) breaker.onFailure();
      throw new StreamAttemptError(pe, !yieldedAny);
    } finally {
      actx.dispose();
    }
  }

  /**
   * Fresh per-attempt abort context: fires on client disconnect or when this
   * attempt's timeout elapses. For streams, the timeout is a *time-to-first-
   * byte* bound — call `startedStreaming()` when the first chunk arrives to
   * lift it, so long generations aren't killed mid-stream by a cap that was
   * meant to catch unresponsive providers. `dispose()` must always run.
   */
  private attemptContext(opts: RouterCallOptions): {
    signal: AbortSignal;
    startedStreaming(): void;
    dispose(): void;
  } {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | null = setTimeout(
      () => ac.abort(new DOMException("Upstream attempt timed out", "TimeoutError")),
      this.cfg.timeoutMs,
    );
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onClientAbort = () => ac.abort(new DOMException("Client disconnected", "AbortError"));
    if (opts.clientSignal?.aborted) onClientAbort();
    else opts.clientSignal?.addEventListener("abort", onClientAbort, { once: true });

    return {
      signal: ac.signal,
      startedStreaming: clearTimer,
      dispose() {
        clearTimer();
        opts.clientSignal?.removeEventListener("abort", onClientAbort);
      },
    };
  }
}

function surfaceClientError(pe: ProviderError): ConduitError {
  return new ConduitError(pe.message, {
    status: pe.status ?? 400,
    type: "invalid_request_error",
    code: "upstream_rejected",
  });
}

function surfaceMidStream(pe: ProviderError): ConduitError {
  return new ConduitError(`Stream interrupted after partial delivery: ${pe.message}`, {
    status: 502,
    type: "api_error",
    code: "stream_interrupted",
  });
}
