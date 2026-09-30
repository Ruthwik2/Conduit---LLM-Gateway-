import { describe, it, expect, afterEach } from "vitest";
import { makeHarness, authHeader, TEST_KEY, type Harness } from "../helpers/harness.js";
import type { ExactStore } from "../../src/cache/exact-store.js";
import type { Embedder } from "../../src/cache/embeddings.js";
import { ClientDisconnectedError } from "../../src/util/errors.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function chat(content: string, extra: Record<string, unknown> = {}) {
  return h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...authHeader() },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content }], ...extra },
  });
}

/** An exact store that behaves like Redis with the plug pulled. */
const deadExactStore: ExactStore = {
  async get() {
    throw new Error("redis: connection refused");
  },
  async set() {
    throw new Error("redis: connection refused");
  },
  async clear() {},
};

/** An embedder that behaves like an embeddings API returning 500s. */
const deadEmbedder: Embedder = {
  dimensions: 256,
  id: "dead",
  async embed() {
    throw new Error("embeddings API unavailable");
  },
};

describe("cache fail-open", () => {
  it("still serves requests when the exact-cache backend is down", async () => {
    h = await makeHarness();
    (h.container.cache as unknown as { exact: ExactStore }).exact = deadExactStore;

    const res = await chat("exact backend is down");
    expect(res.statusCode).toBe(200);
    // The dead cache degrades to a miss; the provider still answers.
    expect(res.headers["x-conduit-cache"]).toBe("miss");
    expect(res.headers["x-conduit-provider"]).toBe("mock-primary");

    // The failure is visible to operators (lookup error, and the post-answer
    // write attempt also fails and is counted).
    const metrics = await h.container.metrics.render();
    expect(metrics).toMatch(/conduit_cache_errors_total\{[^}]*stage="lookup"[^}]*\} [1-9]/);
    expect(metrics).toMatch(/conduit_cache_errors_total\{[^}]*stage="store"[^}]*\} [1-9]/);
  });

  it("still serves requests when the embedder (semantic tier) is down", async () => {
    // Disable the exact tier so the lookup reaches the semantic tier's embedder.
    h = await makeHarness({ cache: { exact: { enabled: false } } });
    (h.container.cache as unknown as { embedder: Embedder }).embedder = deadEmbedder;

    const res = await chat("semantic embedder is down");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-cache"]).toBe("miss");
    expect(res.headers["x-conduit-provider"]).toBe("mock-primary");
  });
});

describe("accounting is non-fatal", () => {
  it("a spend-recording failure never fails a request that was already served", async () => {
    h = await makeHarness();
    // Enforcement (getSpend) keeps working; recording (addSpend) explodes, as it
    // would if Redis dropped between the budget gate and the provider answer.
    h.container.budget.addSpend = async () => {
      throw new Error("redis write failed");
    };

    const res = await chat("accounting backend blip");
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toContain("Echo");
  });
});

describe("stream timeout semantics (time-to-first-byte)", () => {
  const streamChat = (content: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json", ...authHeader() },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content }], stream: true },
    });

  it("does not kill a long generation once the first byte has arrived", async () => {
    h = await makeHarness({ router: { timeoutMs: 150, retriesPerTarget: 0 } });
    // ~12 chunks x 30ms ≈ 360ms of streaming — far past timeoutMs — but the
    // first byte arrives immediately, so the stream must run to completion.
    h.container.registry.findMock("mock-primary")!.setBehavior({
      reply: "one two three four five six seven eight nine ten eleven twelve",
      chunkDelayMs: 30,
    });

    const res = await streamChat("long generation");
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("twelve");
    expect(res.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("still times out a provider that never produces a first byte, and fails over", async () => {
    h = await makeHarness({
      router: { timeoutMs: 100, retriesPerTarget: 0, backoff: { baseMs: 1, maxMs: 2, jitter: false } },
    });
    h.container.registry.findMock("mock-primary")!.setBehavior({ latencyMs: 5_000 });

    const res = await streamChat("slow first byte");
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("mock-fallback"); // served by the fallback
    expect(res.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("interrupted streams", () => {
  const ask = (content: string) => ({
    model: "gpt-4o-mini",
    messages: [{ role: "user" as const, content }],
    stream: true,
  });

  it("accounts a client-aborted stream as 499 without blaming the provider", async () => {
    h = await makeHarness();
    const ac = new AbortController();
    const gen = h.container.pipeline.stream(ask("abort me midway please with several more words"), {
      requestId: "req_test_abort",
      secret: TEST_KEY,
      clientSignal: ac.signal,
    });

    let frames = 0;
    let thrown: unknown = null;
    try {
      for await (const _frame of gen) {
        frames++;
        if (frames === 2) ac.abort(); // client hangs up mid-stream
      }
    } catch (err) {
      thrown = err;
    }

    expect(frames).toBeGreaterThanOrEqual(2);
    expect(thrown).toBeInstanceOf(ClientDisconnectedError);

    // The partial delivery is recorded…
    const key = await h.container.keys.findBySecret(TEST_KEY);
    expect(h.container.usage.forKey(key!.id).requests).toBe(1);

    // …with the conventional 499 status…
    const metrics = await h.container.metrics.render();
    expect(metrics).toMatch(/conduit_requests_total\{[^}]*status="499"/);

    // …and the provider's health untouched: a client hang-up is not its fault.
    const snap = h.container.circuits.snapshots().find((c) => c.provider === "mock-primary");
    expect(snap?.errorRate ?? 0).toBe(0);
    expect(metrics).not.toMatch(/conduit_provider_calls_total\{[^}]*provider="mock-primary"[^}]*outcome="failure"/);
  });

  it("accounts a stream whose consumer disposed it early (socket died)", async () => {
    h = await makeHarness();
    const ac = new AbortController();
    const gen = h.container.pipeline.stream(ask("dispose me early with a fairly long reply text"), {
      requestId: "req_test_dispose",
      secret: TEST_KEY,
      clientSignal: ac.signal,
    });

    await gen.next(); // role chunk
    await gen.next(); // first content chunk
    ac.abort(); // socket close fires the abort signal…
    await gen.return(undefined as never); // …and the route disposes the generator

    const key = await h.container.keys.findBySecret(TEST_KEY);
    expect(h.container.usage.forKey(key!.id).requests).toBe(1);
    const metrics = await h.container.metrics.render();
    expect(metrics).toMatch(/conduit_requests_total\{[^}]*status="499"/);
  });

  it("does not poison the cache with a partial answer", async () => {
    h = await makeHarness();
    const ac = new AbortController();
    const prompt = "partial answers must never be cached okay";
    const gen = h.container.pipeline.stream(ask(prompt), {
      requestId: "req_test_nopoison",
      secret: TEST_KEY,
      clientSignal: ac.signal,
    });
    try {
      let n = 0;
      for await (const _frame of gen) {
        if (++n === 2) ac.abort();
      }
    } catch {
      // expected
    }

    // The same prompt asked again must go to a provider, not the cache.
    const res = await chat(prompt);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-cache"]).toBe("miss");
  });
});
