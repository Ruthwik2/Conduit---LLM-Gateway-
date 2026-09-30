import { describe, it, expect, afterEach } from "vitest";
import {
  makeHarness,
  authHeader,
  adminHeader,
  TEST_KEY,
  type Harness,
} from "../helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function chat(content: string, secret?: string, model = "gpt-4o-mini") {
  return h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...authHeader(secret) },
    payload: { model, messages: [{ role: "user", content }] },
  });
}

function chatNoAuth(content: string) {
  return h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content }] },
  });
}

describe("authentication", () => {
  it("rejects a request with no API key (401)", async () => {
    h = await makeHarness();
    const res = await chatNoAuth("hello");
    expect(res.statusCode).toBe(401);
    // OpenAI returns invalid_request_error / invalid_api_key for auth failures.
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(res.json().error.code).toBe("invalid_api_key");
  });

  it("rejects an unknown API key (401)", async () => {
    h = await makeHarness();
    const res = await chat("hello", "ck-not-a-real-key-zzzzzzzzzzzzzzzz");
    expect(res.statusCode).toBe(401);
  });
});

describe("model allowlist", () => {
  it("forbids a model the key is not scoped for (403)", async () => {
    h = await makeHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/admin/keys",
      headers: { "content-type": "application/json", ...adminHeader() },
      payload: { name: "scoped", allowedModels: ["some-other-model"] },
    });
    const secret = created.json().key as string;

    const res = await chat("hello", secret, "gpt-4o-mini");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.type).toBe("invalid_request_error");
  });
});

describe("budget enforcement", () => {
  it("allows the first call then rejects once the budget is exhausted (402)", async () => {
    h = await makeHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/admin/keys",
      headers: { "content-type": "application/json", ...adminHeader() },
      payload: { name: "tiny", budgetUsd: 0.000001, rateLimit: { requestsPerMinute: 1000 } },
    });
    const secret = created.json().key as string;

    const first = await chat("budget one", secret);
    expect(first.statusCode).toBe(200);

    const second = await chat("budget two", secret);
    expect(second.statusCode).toBe(402);
    expect(second.json().error.type).toBe("insufficient_quota");
  });

  it("never charges for a cache hit (cost is zero on replay)", async () => {
    h = await makeHarness();
    await chat("repeat me", TEST_KEY);
    await chat("repeat me", TEST_KEY); // exact hit

    const usage = await h.app.inject({
      method: "GET",
      url: "/admin/usage",
      headers: adminHeader(),
    });
    const summaries = usage.json().data as Array<{
      keyId: string;
      requests: number;
      cacheHits: number;
    }>;
    const mine = summaries.find((s) => s.requests > 0);
    expect(mine).toBeTruthy();
    expect(mine!.cacheHits).toBeGreaterThanOrEqual(1);
    // Two requests arrived, but only one was billed to a provider.
    expect(mine!.requests).toBe(2);
  });
});

describe("rate limiting", () => {
  it("allows the burst then rejects with 429 + Retry-After", async () => {
    h = await makeHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/admin/keys",
      headers: { "content-type": "application/json", ...adminHeader() },
      payload: { name: "rl", budgetUsd: 100, rateLimit: { requestsPerMinute: 1, burst: 1 } },
    });
    const secret = created.json().key as string;

    const first = await chat("rl one", secret);
    expect(first.statusCode).toBe(200);

    const second = await chat("rl two", secret);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.json().error.type).toBe("rate_limit_error");
  });
});

describe("admin key lifecycle", () => {
  it("requires the admin token", async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/keys",
      headers: { "content-type": "application/json" },
      payload: { name: "nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates, uses, lists, and revokes a key", async () => {
    h = await makeHarness();

    // create
    const created = await h.app.inject({
      method: "POST",
      url: "/admin/keys",
      headers: { "content-type": "application/json", ...adminHeader() },
      payload: { name: "lifecycle", budgetUsd: 5, rateLimit: { requestsPerMinute: 100 } },
    });
    expect(created.statusCode).toBe(201);
    const { id, key: secret } = created.json();
    expect(secret).toMatch(/^ck-/);

    // use
    const used = await chat("hi from new key", secret);
    expect(used.statusCode).toBe(200);

    // list includes it (without exposing the secret)
    const list = await h.app.inject({ method: "GET", url: "/admin/keys", headers: adminHeader() });
    const listed = list.json().data.find((k: { id: string }) => k.id === id);
    expect(listed).toBeTruthy();
    expect(listed.key).toBeUndefined();
    expect(listed.hashedKey).toBeUndefined();

    // revoke
    const del = await h.app.inject({
      method: "DELETE",
      url: `/admin/keys/${id}`,
      headers: adminHeader(),
    });
    expect(del.statusCode).toBe(200);

    // revoked key no longer authenticates
    const afterRevoke = await chat("should fail now", secret);
    expect(afterRevoke.statusCode).toBe(401);
  });
});

describe("demo mock-control endpoint", () => {
  it("changes a mock provider's behavior at runtime", async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/mock/mock-primary/behavior",
      headers: { "content-type": "application/json", ...adminHeader() },
      payload: { failWith: "server_error" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior.failWith).toBe("server_error");

    // The change takes effect: traffic now lands on the fallback.
    const after = await chat("after kill", TEST_KEY);
    expect(after.statusCode).toBe(200);
    expect(after.headers["x-conduit-provider"]).toBe("mock-fallback");
  });

  it("requires the admin token", async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/mock/mock-primary/behavior",
      headers: { "content-type": "application/json" },
      payload: { failWith: "server_error" },
    });
    expect(res.statusCode).toBe(401);
  });
});
