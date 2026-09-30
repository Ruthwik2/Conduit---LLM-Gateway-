import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../../src/router/circuit-breaker.js";
import { circuitBreakerConfigSchema } from "../../src/config/schema.js";

/** A controllable clock so we can drive time-based transitions deterministically. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const cfg = circuitBreakerConfigSchema.parse({
  volumeThreshold: 4,
  errorThreshold: 0.5,
  windowMs: 1000,
  openStateMs: 500,
  halfOpenSuccessThreshold: 2,
});

describe("CircuitBreaker", () => {
  it("stays closed while below the volume threshold even with failures", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    cb.onFailure();
    cb.onFailure();
    cb.onFailure(); // 3 failures < volumeThreshold(4)
    expect(cb.getState()).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  it("opens once volume and error-rate thresholds are both crossed", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    cb.onSuccess(5);
    cb.onSuccess(5);
    cb.onFailure();
    cb.onFailure(); // 4 calls, 50% errors → trips
    expect(cb.getState()).toBe("open");
    expect(cb.allowRequest()).toBe(false);
  });

  it("transitions open → half_open after the cooldown elapses", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    for (let i = 0; i < 4; i++) cb.onFailure();
    expect(cb.getState()).toBe("open");

    clk.advance(499);
    expect(cb.getState()).toBe("open"); // not yet
    clk.advance(1);
    expect(cb.getState()).toBe("half_open"); // cooldown reached
  });

  it("half_open admits only a limited number of probes", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    for (let i = 0; i < 4; i++) cb.onFailure();
    clk.advance(500); // → half_open

    expect(cb.allowRequest()).toBe(true); // probe 1
    expect(cb.allowRequest()).toBe(true); // probe 2 (== halfOpenSuccessThreshold)
    expect(cb.allowRequest()).toBe(false); // no more probes
  });

  it("closes after enough successful probes in half_open", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    for (let i = 0; i < 4; i++) cb.onFailure();
    clk.advance(500); // → half_open
    cb.allowRequest();
    cb.onSuccess(5);
    cb.allowRequest();
    cb.onSuccess(5); // 2 successes → close
    expect(cb.getState()).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  it("re-opens immediately on a failed probe in half_open", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    for (let i = 0; i < 4; i++) cb.onFailure();
    clk.advance(500); // → half_open
    cb.allowRequest();
    cb.onFailure(); // sick again
    expect(cb.getState()).toBe("open");
  });

  it("prunes outcomes outside the rolling window", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    cb.onFailure();
    cb.onFailure();
    clk.advance(1001); // both failures now outside the 1000ms window
    cb.onSuccess(5);
    const snap = cb.snapshot();
    expect(snap.windowCalls).toBe(1);
    expect(snap.errorRate).toBe(0);
  });

  it("reports error rate and mean latency in snapshots", () => {
    const clk = fakeClock();
    const cb = new CircuitBreaker("p", cfg, clk.now);
    cb.onSuccess(10);
    cb.onSuccess(20);
    cb.onFailure();
    const snap = cb.snapshot();
    expect(snap.windowCalls).toBe(3);
    expect(snap.errorRate).toBeCloseTo(1 / 3, 5);
    expect(snap.meanLatencyMs).toBe(15); // mean of successful latencies
  });
});
