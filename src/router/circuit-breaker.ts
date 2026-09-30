import type { CircuitBreakerConfig } from "../config/schema.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitSnapshot {
  provider: string;
  state: CircuitState;
  /** Error rate over the rolling window, 0..1. */
  errorRate: number;
  /** Calls counted in the rolling window. */
  windowCalls: number;
  /** Mean latency (ms) over the window, of successful calls. */
  meanLatencyMs: number;
}

interface Outcome {
  t: number;
  ok: boolean;
  latencyMs: number;
}

/**
 * Per-provider circuit breaker.
 *
 *   closed     — traffic flows; health is tracked over a rolling window.
 *   open       — provider is shed; all calls are rejected fast until cooldown.
 *   half_open  — a small number of probe calls are allowed; enough successes
 *                close the circuit, a single failure re-opens it.
 *
 * This is the classic three-state breaker (Nygard / Hystrix). It converts a
 * degrading dependency from a source of cascading latency into a fast, local
 * "no" — which is what lets the router move on to a healthy provider instantly
 * instead of waiting on timeouts every time.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private outcomes: Outcome[] = [];
  private openedAt = 0;
  private halfOpenProbes = 0;
  private halfOpenSuccesses = 0;

  constructor(
    readonly provider: string,
    private cfg: CircuitBreakerConfig,
    private now: () => number = Date.now,
  ) {}

  /** Current state, after applying any time-based transition (open → half_open). */
  getState(): CircuitState {
    this.maybeReopenToHalfOpen();
    return this.state;
  }

  /**
   * Decide whether a call may proceed. Has side effects: it performs the
   * open→half_open transition when cooldown elapses and meters half-open probes.
   */
  allowRequest(): boolean {
    this.maybeReopenToHalfOpen();

    switch (this.state) {
      case "closed":
        return true;
      case "open":
        return false;
      case "half_open":
        if (this.halfOpenProbes < this.cfg.halfOpenSuccessThreshold) {
          this.halfOpenProbes++;
          return true;
        }
        return false;
    }
  }

  onSuccess(latencyMs: number): void {
    this.record(true, latencyMs);
    if (this.state === "half_open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.cfg.halfOpenSuccessThreshold) {
        this.close();
      }
    }
  }

  onFailure(): void {
    this.record(false, 0);
    if (this.state === "half_open") {
      // A failed probe means the dependency is still sick: re-open immediately.
      this.open();
      return;
    }
    if (this.state === "closed") {
      this.evaluate();
    }
  }

  snapshot(): CircuitSnapshot {
    this.prune();
    const calls = this.outcomes.length;
    const failures = this.outcomes.filter((o) => !o.ok).length;
    const successes = this.outcomes.filter((o) => o.ok);
    const meanLatency =
      successes.length > 0 ? successes.reduce((s, o) => s + o.latencyMs, 0) / successes.length : 0;
    return {
      provider: this.provider,
      state: this.getState(),
      errorRate: calls > 0 ? failures / calls : 0,
      windowCalls: calls,
      meanLatencyMs: meanLatency,
    };
  }

  // --- internals -----------------------------------------------------------

  private record(ok: boolean, latencyMs: number): void {
    this.outcomes.push({ t: this.now(), ok, latencyMs });
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.cfg.windowMs;
    if (this.outcomes.length && this.outcomes[0]!.t < cutoff) {
      this.outcomes = this.outcomes.filter((o) => o.t >= cutoff);
    }
  }

  private evaluate(): void {
    this.prune();
    if (this.outcomes.length < this.cfg.volumeThreshold) return;
    const failures = this.outcomes.filter((o) => !o.ok).length;
    const errorRate = failures / this.outcomes.length;
    if (errorRate >= this.cfg.errorThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.halfOpenProbes = 0;
    this.halfOpenSuccesses = 0;
  }

  private close(): void {
    this.state = "closed";
    this.outcomes = [];
    this.halfOpenProbes = 0;
    this.halfOpenSuccesses = 0;
  }

  private maybeReopenToHalfOpen(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.cfg.openStateMs) {
      this.state = "half_open";
      this.halfOpenProbes = 0;
      this.halfOpenSuccesses = 0;
    }
  }
}

/** Owns one breaker per provider and exposes snapshots for metrics. */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  constructor(
    private cfg: CircuitBreakerConfig,
    private now: () => number = Date.now,
  ) {}

  get(provider: string): CircuitBreaker {
    let b = this.breakers.get(provider);
    if (!b) {
      b = new CircuitBreaker(provider, this.cfg, this.now);
      this.breakers.set(provider, b);
    }
    return b;
  }

  snapshots(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }
}
