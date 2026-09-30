import { describe, it, expect, afterEach } from "vitest";
import { makeHarness, authHeader, type Harness } from "../helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

// Fast failover settings: no same-target retries (instant move to the next
// provider) and a low circuit volume threshold so we can trip it in a few calls.
const FAST = {
  router: {
    retriesPerTarget: 0,
    timeoutMs: 2000,
    backoff: { baseMs: 1, maxMs: 2, jitter: false },
    circuitBreaker: {
      volumeThreshold: 3,
      errorThreshold: 0.5,
      windowMs: 60_000,
      openStateMs: 100,
      halfOpenSuccessThreshold: 1,
    },
  },
};

function chat(content: string, stream = false) {
  return h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...authHeader() },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content }], stream },
  });
}

function circuitState(provider: string): string | undefined {
  return h.container.circuits.snapshots().find((c) => c.provider === provider)?.state;
}

describe("failover", () => {
  it("a single request still succeeds via the fallback when the primary fails", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");

    const res = await chat("unique probe one");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-provider"]).toBe("mock-fallback");
  });

  it("delivers zero caller-facing failures across a burst while the primary is down", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await chat(`burst ${i} unique`);
      statuses.push(res.statusCode);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("opens the primary's circuit after the failure threshold is crossed", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");

    for (let i = 0; i < 4; i++) await chat(`trip ${i} unique`);
    expect(circuitState("mock-primary")).toBe("open");
    // Fallback stayed healthy throughout.
    expect(circuitState("mock-fallback")).toBe("closed");
  });

  it("skips an open circuit on subsequent calls (fast local 'no')", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");
    for (let i = 0; i < 4; i++) await chat(`open ${i} unique`); // trip it

    const before = h.container.metrics; // circuit rejections recorded in metrics
    const res = await chat("after-open unique");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-provider"]).toBe("mock-fallback");
    const dump = await before.render();
    expect(dump).toMatch(/conduit_circuit_rejections_total\{provider="mock-primary"/);
  });

  it("streams via the fallback when the primary fails before the first byte", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");

    const res = await chat("stream failover unique", true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // The fallback's echo proves who actually served the stream.
    expect(res.payload).toContain("mock-fallback");
    expect(res.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("returns 502 when every provider is unavailable", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");
    h.mock("mock-fallback").fail("server_error");

    const res = await chat("all down unique");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe("api_error");
  });

  it("recovers automatically once the primary is healthy again", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("server_error");
    const failed = await chat("before recovery unique");
    expect(failed.headers["x-conduit-provider"]).toBe("mock-fallback");

    h.mock("mock-primary").recover();
    const ok = await chat("after recovery unique");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-conduit-provider"]).toBe("mock-primary");
  });
});

describe("client-fault handling", () => {
  it("short-circuits on a 4xx from the primary (no pointless failover)", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("client_error");

    const res = await chat("bad request unique");
    // A 4xx is the caller's fault — retrying the fallback would only reproduce it,
    // so we surface it immediately rather than serving a 200 from the fallback.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("does not count a 4xx against provider health", async () => {
    h = await makeHarness(FAST);
    h.mock("mock-primary").fail("client_error");
    for (let i = 0; i < 5; i++) await chat(`client err ${i} unique`);
    // Client errors must never open a circuit.
    expect(circuitState("mock-primary")).toBe("closed");
  });
});
