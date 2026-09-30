// Load-test harness for Conduit.
//
// Spins up the gateway as a child process against its zero-dependency in-memory
// backends and the offline MockProvider (so the numbers reflect gateway
// overhead, not a real network), then runs two scenarios with autocannon:
//
//   1. cache-miss  — every request has a unique prompt, so it flows all the way
//      through auth → governance → routing → mock provider → accounting.
//   2. cache-hit   — every request repeats one prompt, exercising the exact-cache
//      replay path (the hot path that protects your provider spend).
//
// Usage:  npm run bench           (defaults: 10s, 50 connections each)
//         DURATION=20 CONNECTIONS=100 npm run bench
//
// Requires nothing running beforehand — it manages the server itself.

import autocannon from "autocannon";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.BENCH_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "ck-demo-0000000000000000000000000000";
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);

function startServer() {
  const child = spawn("node_modules/.bin/tsx", ["src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      DEMO_KEY: KEY,
    },
    stdio: "ignore",
    detached: true, // own process group, so we can kill the whole tree
  });
  child.unref();
  return child;
}

function stopServer(child) {
  try {
    process.kill(-child.pid, "SIGTERM"); // negative pid → the process group
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("server did not become ready in time");
}

function run(opts) {
  return new Promise((resolve, reject) => {
    autocannon(opts, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${KEY}`,
};

/**
 * Mint a dedicated benchmark key with effectively unlimited budget and rate so
 * that governance (which is doing its job) doesn't become the bottleneck we
 * accidentally measure. Returns the new secret.
 */
async function mintBenchKey() {
  const res = await fetch(`${BASE}/admin/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dev-admin-token" },
    body: JSON.stringify({
      name: "bench",
      budgetUsd: null, // unlimited
      rateLimit: { requestsPerMinute: 1_000_000_000, burst: 1_000_000_000 },
    }),
  });
  const body = await res.json();
  if (!body.key) throw new Error(`failed to mint bench key: ${JSON.stringify(body)}`);
  return body.key;
}

async function scenarioMiss(secret) {
  const reqHeaders = { "content-type": "application/json", authorization: `Bearer ${secret}` };
  let n = 0;
  const uniqueBody = () =>
    JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `benchmark unique prompt ${Date.now()}-${n++}` }],
    });

  // Vary the body per request via the `response` event + client.setBody(), which
  // recomputes Content-Length correctly (unlike inline [<id>] replacement). Every
  // request is therefore a distinct prompt → guaranteed cache miss → full pipeline.
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: `${BASE}/v1/chat/completions`,
        method: "POST",
        headers: reqHeaders,
        body: uniqueBody(),
        duration: DURATION,
        connections: CONNECTIONS,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    instance.on("response", (client) => client.setBody(uniqueBody()));
  });
}

async function scenarioHit(secret) {
  const reqHeaders = { "content-type": "application/json", authorization: `Bearer ${secret}` };
  const fixedBody = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "benchmark cached prompt" }],
  });
  // Warm the cache once, then hammer the identical request → exact-cache replay.
  await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: reqHeaders, body: fixedBody });
  return run({
    url: BASE,
    duration: DURATION,
    connections: CONNECTIONS,
    requests: [{ method: "POST", path: "/v1/chat/completions", headers: reqHeaders, body: fixedBody }],
  });
}

function summarize(label, r) {
  const line = (k, v) => `  ${k.padEnd(22)} ${v}`;
  console.log(`\n=== ${label} ===`);
  console.log(line("Requests/sec (avg)", r.requests.average.toFixed(0)));
  console.log(line("Throughput (avg)", `${(r.throughput.average / 1024 / 1024).toFixed(2)} MB/s`));
  console.log(line("Latency p50", `${r.latency.p50} ms`));
  console.log(line("Latency p90", `${r.latency.p90} ms`));
  console.log(line("Latency p99", `${r.latency.p99} ms`));
  console.log(line("Latency max", `${r.latency.max} ms`));
  console.log(line("2xx responses", r["2xx"]));
  console.log(line("non-2xx responses", r.non2xx));
}

async function main() {
  console.log(
    `Booting Conduit on :${PORT} (in-memory, MockProvider) — ${CONNECTIONS} connections × ${DURATION}s per scenario`,
  );
  const server = startServer();
  try {
    await waitForReady();
    const secret = await mintBenchKey();
    const miss = await scenarioMiss(secret);
    summarize("Scenario 1 — cache MISS (full pipeline + provider)", miss);
    const hit = await scenarioHit(secret);
    summarize("Scenario 2 — cache HIT (exact-cache replay)", hit);

    const speedup = hit.requests.average / Math.max(1, miss.requests.average);
    console.log(
      `\nCache-hit path is ~${speedup.toFixed(1)}× the throughput of the miss path on this hardware.`,
    );
    console.log("\nNote: MockProvider adds no artificial latency, so these reflect gateway overhead.");
  } finally {
    stopServer(server);
    await sleep(300);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
