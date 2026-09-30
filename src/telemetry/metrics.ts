import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { TokenUsage } from "../types/openai.js";
import type { ServeOutcome } from "../types/internal.js";
import type { CircuitSnapshot, CircuitState } from "../router/circuit-breaker.js";
import type { RouterMetrics } from "../router/router.js";

const STATE_VALUE: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };

export interface RequestMetric {
  keyId: string;
  model: string;
  provider: string | null;
  outcome: ServeOutcome;
  status: number;
  durationMs: number;
  usage: TokenUsage;
  costUsd: number;
}

/**
 * All Prometheus instrumentation for the gateway, on a private registry (so
 * tests don't collide on the global default and multiple app instances stay
 * isolated). Implements `RouterMetrics` so the router can report provider-level
 * outcomes without importing prom-client.
 */
export class Metrics implements RouterMetrics {
  readonly registry = new Registry();
  private circuitSource: (() => CircuitSnapshot[]) | null = null;

  private requests: Counter<"key" | "model" | "provider" | "outcome" | "status">;
  private duration: Histogram<"model" | "outcome">;
  private cost: Counter<"key" | "model">;
  private tokens: Counter<"model" | "direction">;
  private cacheEvents: Counter<"type">;
  private cacheErrors: Counter<"stage">;
  private providerCalls: Counter<"provider" | "outcome" | "kind">;
  private circuitRejections: Counter<"provider">;
  private circuitState: Gauge<"provider">;

  constructor() {
    this.registry.setDefaultLabels({ service: "conduit" });
    collectDefaultMetrics({ register: this.registry });

    this.requests = new Counter({
      name: "conduit_requests_total",
      help: "Total chat-completion requests by key, model, provider, outcome, and HTTP status.",
      labelNames: ["key", "model", "provider", "outcome", "status"],
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: "conduit_request_duration_seconds",
      help: "End-to-end request handling latency.",
      labelNames: ["model", "outcome"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });
    this.cost = new Counter({
      name: "conduit_cost_usd_total",
      help: "Cumulative provider spend in USD by key and model.",
      labelNames: ["key", "model"],
      registers: [this.registry],
    });
    this.tokens = new Counter({
      name: "conduit_tokens_total",
      help: "Token throughput by model and direction (prompt|completion).",
      labelNames: ["model", "direction"],
      registers: [this.registry],
    });
    this.cacheEvents = new Counter({
      name: "conduit_cache_events_total",
      help: "Cache outcomes (exact_hit|semantic_hit|miss).",
      labelNames: ["type"],
      registers: [this.registry],
    });
    this.cacheErrors = new Counter({
      name: "conduit_cache_errors_total",
      help: "Cache backend failures by stage (lookup|store). Reads fail open (treated as a miss).",
      labelNames: ["stage"],
      registers: [this.registry],
    });
    this.providerCalls = new Counter({
      name: "conduit_provider_calls_total",
      help: "Upstream provider call outcomes by provider, outcome, and failure kind.",
      labelNames: ["provider", "outcome", "kind"],
      registers: [this.registry],
    });
    this.circuitRejections = new Counter({
      name: "conduit_circuit_rejections_total",
      help: "Requests shed because a provider's circuit was open.",
      labelNames: ["provider"],
      registers: [this.registry],
    });
    this.circuitState = new Gauge({
      name: "conduit_circuit_state",
      help: "Circuit breaker state per provider (0=closed, 1=half_open, 2=open).",
      labelNames: ["provider"],
      registers: [this.registry],
    });
  }

  /** Record a fully-resolved request. Called once per request by the pipeline. */
  recordRequest(m: RequestMetric): void {
    const provider = m.provider ?? "none";
    this.requests.inc({
      key: m.keyId,
      model: m.model,
      provider,
      outcome: m.outcome,
      status: String(m.status),
    });
    this.duration.observe({ model: m.model, outcome: m.outcome }, m.durationMs / 1000);
    if (m.costUsd > 0) this.cost.inc({ key: m.keyId, model: m.model }, m.costUsd);
    if (m.usage.prompt_tokens > 0)
      this.tokens.inc({ model: m.model, direction: "prompt" }, m.usage.prompt_tokens);
    if (m.usage.completion_tokens > 0)
      this.tokens.inc({ model: m.model, direction: "completion" }, m.usage.completion_tokens);

    const type =
      m.outcome === "cache_exact"
        ? "exact_hit"
        : m.outcome === "cache_semantic"
          ? "semantic_hit"
          : "miss";
    this.cacheEvents.inc({ type });
  }

  /** A cache backend failed; the request continued (fail-open) or the write was dropped. */
  cacheError(stage: "lookup" | "store"): void {
    this.cacheErrors.inc({ stage });
  }

  // ---- RouterMetrics ----
  providerCall(provider: string, outcome: "success" | "failure", kind?: string): void {
    this.providerCalls.inc({ provider, outcome, kind: kind ?? "none" });
  }

  circuitRejection(provider: string): void {
    this.circuitRejections.inc({ provider });
  }

  /** Let /metrics reflect live circuit states pulled from the breaker registry. */
  bindCircuitSource(fn: () => CircuitSnapshot[]): void {
    this.circuitSource = fn;
  }

  private refreshCircuits(): void {
    if (!this.circuitSource) return;
    for (const snap of this.circuitSource()) {
      this.circuitState.set({ provider: snap.provider }, STATE_VALUE[snap.state]);
    }
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Render the Prometheus exposition text (refreshing gauges first). */
  async render(): Promise<string> {
    this.refreshCircuits();
    return this.registry.metrics();
  }
}
