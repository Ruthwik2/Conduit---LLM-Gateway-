import { describe, it, expect, afterEach } from "vitest";
import { makeHarness, authHeader, adminHeader, TEST_KEY, type Harness } from "../helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const ASK = { model: "gpt-4o-mini", messages: [{ role: "user", content: "a prompt two tenants share" }] };

function chat(secret: string) {
  return h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...authHeader(secret) },
    payload: ASK,
  });
}

async function mintKey(name: string): Promise<string> {
  const created = await h.app.inject({
    method: "POST",
    url: "/admin/keys",
    headers: { "content-type": "application/json", ...adminHeader() },
    payload: { name, rateLimit: { requestsPerMinute: 1000 } },
  });
  return created.json().key as string;
}

describe("cache.scope = per_key", () => {
  it("never replays one key's answer to another key (both tiers isolated)", async () => {
    h = await makeHarness({ cache: { scope: "per_key" } });
    const tenantB = await mintKey("tenant-b");

    // Tenant A primes its own cache…
    expect((await chat(TEST_KEY)).headers["x-conduit-cache"]).toBe("miss");

    // …tenant B asking the *identical* prompt is still a miss — no exact hit,
    // and no semantic hit either (buckets are scoped too).
    expect((await chat(tenantB)).headers["x-conduit-cache"]).toBe("miss");

    // Each tenant then hits its own entry.
    expect((await chat(TEST_KEY)).headers["x-conduit-cache"]).toBe("exact");
    expect((await chat(tenantB)).headers["x-conduit-cache"]).toBe("exact");
  });
});

describe("cache.scope = shared (default)", () => {
  it("lets keys share entries for maximum dedupe", async () => {
    h = await makeHarness();
    const tenantB = await mintKey("tenant-b");

    expect((await chat(TEST_KEY)).headers["x-conduit-cache"]).toBe("miss");
    // Same prompt from a different key is served from the shared cache.
    expect((await chat(tenantB)).headers["x-conduit-cache"]).toBe("exact");
  });
});
