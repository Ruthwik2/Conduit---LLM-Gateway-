import { describe, it, expect, afterEach } from "vitest";
import { makeHarness, authHeader, type Harness } from "../helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function chat(body: Record<string, unknown>, secret?: string) {
  return h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...authHeader(secret) },
    payload: body,
  });
}

const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content }],
  ...extra,
});

describe("POST /v1/chat/completions", () => {
  it("serves a provider completion and reports cache miss + provider", async () => {
    h = await makeHarness();
    const res = await chat(ask("What is the capital of France?"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-cache"]).toBe("miss");
    expect(res.headers["x-conduit-provider"]).toBe("mock-primary");
    expect(res.headers["x-conduit-request-id"]).toMatch(/^req_/);

    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(typeof body.choices[0].message.content).toBe("string");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("returns an exact cache hit for an identical request (no provider, zero new spend)", async () => {
    h = await makeHarness();
    await chat(ask("Tell me a joke"));
    const res = await chat(ask("Tell me a joke"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-cache"]).toBe("exact");
    expect(res.headers["x-conduit-provider"]).toBe("none");
  });

  it("returns a semantic cache hit for a near-duplicate prompt", async () => {
    h = await makeHarness();
    await chat(ask("What is the capital of France?"));
    const res = await chat(ask("What is the capital of France???"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-conduit-cache"]).toBe("semantic");
    expect(res.headers["x-conduit-provider"]).toBe("none");
  });

  it("does not serve a semantic hit above the temperature ceiling", async () => {
    h = await makeHarness();
    // Prime at low temperature, then ask a near-duplicate at high temperature.
    await chat(ask("Describe the ocean", { temperature: 0.2 }));
    const res = await chat(ask("Describe the ocean!", { temperature: 1.5 }));
    expect(res.headers["x-conduit-cache"]).toBe("miss");
  });

  it("streams Server-Sent Events ending with [DONE]", async () => {
    h = await makeHarness();
    const res = await chat(ask("stream me something", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const body = res.payload;
    expect(body).toContain("data: ");
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("replays a cached answer as a stream when stream:true on a cache hit", async () => {
    h = await makeHarness();
    await chat(ask("cache then stream")); // prime exact cache (non-stream)
    const res = await chat(ask("cache then stream", { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.payload.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("rejects a malformed request body with a 400 validation error", async () => {
    h = await makeHarness();
    const res = await chat({ model: "gpt-4o-mini" }); // missing messages
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("GET /v1/models", () => {
  it("lists configured route models in OpenAI shape", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o-mini");
    expect(body.data[0].owned_by).toBe("conduit");
  });
});

describe("observability endpoints", () => {
  it("exposes /healthz and /readyz", async () => {
    h = await makeHarness();
    expect((await h.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("emits Prometheus metrics after traffic", async () => {
    h = await makeHarness();
    await chat(ask("metrics please"));
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("conduit_requests_total");
    expect(res.payload).toContain("conduit_cache_events_total");
  });
});
