# Conduit

**A self-hostable, OpenAI-compatible LLM gateway** — one endpoint in front of OpenAI, Anthropic, and any compatible provider, adding caching, automatic failover, cost control, and full observability without changing a line of your application code.

Point your existing OpenAI SDK at Conduit and immediately get: a two-tier response cache (exact + semantic) that cuts spend and latency, health-aware failover with circuit breaking so a flaky provider never takes you down, per-key budgets and rate limits, and Prometheus/Grafana dashboards for everything.

```
            ┌──────────────────────── Conduit ────────────────────────┐
            │                                                          │
OpenAI SDK ─┼─▶ auth ─▶ rate-limit ─▶ budget ─▶ cache ─▶ router ──────┼─▶ OpenAI
 (unchanged)│           (virtual keys)          (exact +    (failover, │   Anthropic
            │                                    semantic)   breaker)   │   mock / …
            │                         ▲                                │
            │                         └─ metrics ─▶ Prometheus ─▶ Grafana
            └──────────────────────────────────────────────────────────┘
```

---

## Why

Calling LLM providers directly from an app means re-implementing the same cross-cutting concerns everywhere: retries and failover, spend tracking, rate limiting, caching, and metrics. Conduit centralizes them in a single OpenAI-compatible hop, so:

- **You don't change your code.** It speaks the OpenAI `/v1/chat/completions` API, including streaming. Set `base_url` and go.
- **You spend less.** Identical and *near-identical* requests are served from cache at `$0` and single-digit-millisecond latency.
- **You stay up.** When a provider degrades, requests fail over to a healthy one; a circuit breaker sheds load from sick providers instead of waiting on timeouts.
- **You stay in control.** Every caller is a virtual key with its own budget, rate limit, and model allow-list. Spend is metered per key.
- **You can see everything.** Request rate, latency percentiles, cache-hit rate, error rate, circuit state, and cost-per-key are all exported to Prometheus and visualized in a ready-made Grafana dashboard.

## Features

- **OpenAI-compatible API** — drop-in `/v1/chat/completions` (streaming + non-streaming) and `/v1/models`.
- **Two-tier caching** — exact (hash) cache plus a **semantic** cache that matches paraphrases/re-asks above a cosine-similarity threshold, with correctness guards (skips high-temperature and tool-calling requests, never crosses models or parameters) Scope is configurable: shared across all keys (default, maximum savings) or isolated per key for multi-tenant privacy.
- **Health-aware failover** — ordered provider targets per model; retriable errors (429/5xx/timeouts) fail over, caller-faults (4xx) short-circuit immediately.
- **Circuit breaking** — a classic three-state breaker per provider turns a degrading dependency into a fast local "no."
- **Cost control** — virtual keys with hard USD budgets (enforced *before* the call) and post-call metering. Cache hits are never billed.
- **Rate limiting** — token-bucket per key (requests/minute + burst).
- **Client-disconnect cancellation** — when a caller hangs up mid-stream, the upstream call is aborted (no tokens generated for nobody), the partial delivery is still metered (status 499), and the provider's health record is untouched.
- **Fails safe** — governance gates fail *closed* (an unverifiable key/limit/budget is rejected); the cache fails *open* (a Redis/pgvector/embeddings outage degrades to cache misses — visible in metrics — never an outage of the gateway).
- **Observability** — Prometheus metrics + provisioned Grafana dashboard; structured JSON logs (pino).
- **Pluggable storage** — everything runs fully in-memory for local/dev/test, or against **Redis** (cache, keys, limits, budgets) and **pgvector** (semantic cache) for horizontal scale — selected purely by config.
- **Runs with zero API keys** — a controllable mock provider and a deterministic local embedder make the whole system runnable, demoable, and testable offline.

---

## Quick start

### Option A — zero-config, no dependencies

Requires Node ≥ 20.

```bash
npm install
npm start
```

That boots a gateway on `http://localhost:8080` with two mock providers, a demo virtual key, in-memory cache, and the local hash embedder — no API keys, no Redis, no Postgres. Try it:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer ck-demo-0000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}]}'
```

The response includes `x-conduit-cache: miss|exact|semantic` and `x-conduit-provider` headers so you can see what happened. Send the same request again and watch it become an `exact` hit served by provider `none`.

### Option B — full stack with Docker

Brings up Conduit + Redis + Postgres/pgvector + Prometheus + Grafana:

```bash
docker compose up --build
```

- Gateway → http://localhost:8080
- Prometheus → http://localhost:9090
- Grafana → http://localhost:3000 (admin / admin) — the **Conduit — LLM Gateway Overview** dashboard is auto-provisioned.

Compose injects `REDIS_URL` and `DATABASE_URL`, so even the zero-config default transparently uses Redis and pgvector — a fully observable gateway with no API keys. To use real providers, copy the config and set keys:

```bash
cp config/conduit.example.yaml config/conduit.yaml
cp .env.example .env   # then fill in OPENAI_API_KEY / ANTHROPIC_API_KEY
docker compose up --build
```

### Use it from the OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="ck-demo-0000000000000000000000000000",  # a Conduit virtual key
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Explain failover in one sentence."}],
)
print(resp.choices[0].message.content)
```

---

## Demo walkthrough

A five-minute tour of every capability, against the zero-config server (`npm start`). The admin token is `dev-admin-token`.

**1. Caching cuts cost and latency.** Fire the same prompt twice, then a near-duplicate:

```bash
ASK='{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is the capital of France?"}]}'
curl -s -D- -o/dev/null http://localhost:8080/v1/chat/completions -H "Authorization: Bearer ck-demo-0000000000000000000000000000" -H "Content-Type: application/json" -d "$ASK" | grep -i x-conduit
# → x-conduit-cache: miss

curl ... -d "$ASK"                 # → x-conduit-cache: exact   (served at $0)
curl ... -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is the capital of France???"}]}'
# → x-conduit-cache: semantic   (paraphrase matched, also $0)
```

**2. Failover + circuit breaking.** Kill the primary provider at runtime (demo control), then send traffic — it succeeds via the fallback, and after enough failures the primary's circuit opens:

```bash
curl -s -XPOST http://localhost:8080/admin/mock/mock-primary/behavior \
  -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
  -d '{"failWith":"server_error"}'

# requests now come back from mock-fallback with zero caller-facing errors
curl ... -d "$ASK"     # → 200, x-conduit-provider: mock-fallback

curl -s http://localhost:8080/status | jq '.circuits'
# → mock-primary "open", mock-fallback "closed"
```

**3. Per-key cost control.** Mint a key with a tiny budget and watch the budget gate reject once it's spent:

```bash
SECRET=$(curl -s -XPOST http://localhost:8080/admin/keys -H "Authorization: Bearer dev-admin-token" \
  -H "Content-Type: application/json" -d '{"name":"demo","budgetUsd":0.0001}' | jq -r .key)

# ...spend it, then the next call returns HTTP 402 insufficient_quota
curl -s http://localhost:8080/admin/usage -H "Authorization: Bearer dev-admin-token" | jq
```

**4. Watch it in Grafana.** With the Docker stack running, open http://localhost:3000 → *Conduit — LLM Gateway Overview* to see request rate, p50/p99 latency, cache-hit rate, provider outcomes, circuit state, and cumulative cost-per-key update live as you run the steps above.

---

## API reference

### Inference
- `POST /v1/chat/completions` — OpenAI-compatible chat completions. Honors `stream: true` (Server-Sent Events). Auth via `Authorization: Bearer <virtual-key>`. Response headers: `x-conduit-cache` (`miss|exact|semantic`), `x-conduit-provider`, `x-conduit-request-id`.
- `GET /v1/models` — lists the models you've routed, in OpenAI list shape.

### Admin (require `Authorization: Bearer <adminToken>`)
- `POST /admin/keys` — create a virtual key; the secret is returned **once**. Body: `{ name, budgetUsd?, rateLimit?: { requestsPerMinute, burst? }, allowedModels? }`.
- `GET /admin/keys` — list keys (never exposes secrets/hashes).
- `DELETE /admin/keys/:id` — revoke a key.
- `GET /admin/keys/:id/usage` — spend, budget, remaining, and request/cache counts for one key.
- `GET /admin/usage` — usage summaries for all keys.
- `POST /admin/mock/:name/behavior` — *demo only* (gated by `enableDemoControls`): drive a mock provider's behavior (`failWith`, `failFirst`, `latencyMs`, `chunkDelayMs`, `reply`) to simulate outages and paced streams.

### Observability
- `GET /metrics` — Prometheus exposition.
- `GET /healthz` — liveness. `GET /readyz` — readiness.
- `GET /status` — models + live circuit-breaker snapshots (unauthenticated, safe summary).

---

## How it works

**Request lifecycle.** Each request is authenticated to a virtual key, checked against that key's rate limit and remaining budget, and matched to a route. The cache is consulted (exact first, then semantic); a hit is returned immediately (and replayed as a stream if the client asked for one). On a miss, the router walks the route's provider targets — skipping any whose circuit is open — and calls the first healthy one, retrying with backoff and failing over on retriable errors. The answer is metered (tokens + cost), written to the cache, and recorded in metrics.

**Failure philosophy.** The gates fail closed, the cache fails open, and accounting never takes back an answer: a cache-backend or embeddings failure is logged, counted (`conduit_cache_errors_total`), and treated as a miss; an accounting failure after a served response is logged loudly rather than surfaced to the caller. Streams are accounted even when they end early — a client disconnect is recorded with status **499** (and cancels the upstream call), a mid-stream provider failure with **502** — and partial answers are never written to the cache.

**Caching.** The exact tier hashes the answer-affecting shape of the request (messages + parameters, ignoring transport details like `stream`), so transport-only differences still hit. The semantic tier embeds the prompt and finds a neighbor above a cosine-similarity threshold within the same model+parameter "bucket." Semantic matching is deliberately skipped when it would be unsafe — high `temperature` (non-deterministic), tool-calling (a paraphrase may warrant different tools), or `n > 1`. Cache hits cost `$0` and are never billed, though their tokens are still counted.

**Failover & circuit breaking.** Errors are classified: 429/5xx/timeout/connection are *retriable* and count against provider health; 4xx is a *caller fault* — not retriable, doesn't count against health, and short-circuits the whole walk (other providers would only reproduce it). Each provider has a three-state circuit breaker (closed → open → half-open) that opens when the error rate over a rolling window crosses a threshold, sheds load while open, then probes for recovery. Streaming fails over only *up to the first byte* — once bytes are on the wire, a mid-stream error is surfaced rather than silently retried. The per-attempt timeout bounds *time-to-first-byte* for streams: it catches an unresponsive provider, but once bytes are flowing a long generation is never killed by a total-duration cap.

**Cost & rate control.** Budgets are enforced *before* the upstream call (so you can't overspend) and metered after. Rate limiting is a per-key token bucket (requests/minute + burst). Both are backed by Redis in multi-instance deployments so limits hold across replicas.

---

## Configuration

Configuration is a YAML file at `config/conduit.yaml` (or `$CONDUIT_CONFIG`), with `${ENV_VAR}` substitution so secrets stay in the environment. Only `providers` and `routes` are required; everything else has defaults. A few knobs (`PORT`, `LOG_LEVEL`, `ADMIN_TOKEN`, `REDIS_URL`, `DATABASE_URL`) can be set via environment variables that override the file.

Notable knobs: `cache.scope` (`shared` | `per_key`) controls whether virtual keys share cache entries or are isolated per tenant.

See **[`config/conduit.example.yaml`](config/conduit.example.yaml)** for a fully-commented reference covering OpenAI + Anthropic providers, multi-target failover routes, the router/circuit-breaker tuning, cache settings, Redis + pgvector backends, OpenAI embeddings, and seed keys.

---

## Observability

Conduit exports these Prometheus metrics (all labeled `service="conduit"`):

| Metric | Type | What it tells you |
| --- | --- | --- |
| `conduit_requests_total` | counter | requests by key, model, provider, outcome, status |
| `conduit_request_duration_seconds` | histogram | end-to-end latency (drives p50/p95/p99) |
| `conduit_cache_events_total` | counter | `exact_hit` / `semantic_hit` / `miss` |
| `conduit_cache_errors_total` | counter | cache-backend failures by stage (`lookup` fails open, `store` is dropped) |
| `conduit_provider_calls_total` | counter | upstream call outcomes by provider + failure kind |
| `conduit_circuit_state` | gauge | breaker state per provider (0/1/2) |
| `conduit_circuit_rejections_total` | counter | requests shed by an open circuit |
| `conduit_cost_usd_total` | counter | cumulative spend by key + model |
| `conduit_tokens_total` | counter | token throughput by model + direction |

The provisioned Grafana dashboard (`grafana/dashboards/conduit.json`) turns these into panels for traffic, latency percentiles, cache-hit rate, error rate, provider health, circuit state, cost-per-key, and token throughput.

---

## Benchmarks

A built-in [autocannon](https://github.com/mcollina/autocannon) harness boots the gateway against its in-memory backends and the zero-latency mock provider (so the numbers reflect **gateway overhead**, not a real network) and runs two scenarios:

```bash
npm run bench                          # 10s × 50 connections per scenario
DURATION=20 CONNECTIONS=100 npm run bench
```

Indicative results from a single shared vCPU sandbox (your hardware will do far better):

| Scenario | Throughput | p50 | p99 | Errors |
| --- | --- | --- | --- | --- |
| Cache **miss** (full pipeline + provider) | ~545 req/s | 44 ms | 88 ms | 0 |
| Cache **hit** (exact-cache replay) | ~3000 req/s | 6 ms | 43 ms | 0 |

The cache-hit hot path sustains several times the throughput of the full path at a fraction of the latency — and against real providers the gap is far larger, because a hit avoids the upstream round-trip entirely.

---

## Testing

```bash
npm test            # 84 tests (unit + integration), no external services needed
npm run typecheck   # strict tsc --noEmit
```

The suite covers the circuit breaker's state machine, cache-key derivation, the hashing embedder's similarity properties, pricing, and SSE replay (unit), plus full HTTP-level behavior — caching, streaming, failover, circuit opening, auth, budgets, rate limiting, the admin key lifecycle, cache fail-open under backend outages, per-key cache isolation, interrupted-stream accounting, and time-to-first-byte stream timeouts (integration, via `app.inject`). Everything runs in-memory against the mock provider, so the tests are fast and hermetic.

---

## Project structure

```
src/
  types/        OpenAI + internal type definitions
  providers/    provider adapters (openai, anthropic, mock) + registry + error classification
  router/       failover router, circuit breaker, backoff
  cache/        exact + semantic stores, embeddings, cache keys, cache service
  auth/         virtual keys + key stores (memory / redis)
  governance/   rate limiting + budgets (memory / redis)
  accounting/   pricing + usage aggregation
  telemetry/    pino logger + prom-client metrics
  pipeline/     the request pipeline tying it all together
  routes/       fastify routes (chat, admin, models, observability)
  config/       zod schema + YAML loader
  wiring.ts     dependency injection (selects backends from config)
  app.ts        fastify app    server.ts  entrypoint
test/           unit + integration suites
bench/          autocannon load harness
grafana/ prometheus/   provisioned observability stack
```

Storage is abstracted behind interfaces with both in-memory and Redis/pgvector implementations; `wiring.ts` picks the backend from config, so the same code path runs locally and at scale.

---

## Roadmap

Conduit v1 is intentionally focused. Natural next steps:

- **Guardrails middleware** — pluggable request/response validation (PII redaction, content policy, schema enforcement).
- **Canary & A/B routing** — split traffic across models/providers by weight for safe rollouts and quality comparisons.
- **Expanded benchmarks** — latency-injected provider profiles and cache-hit-ratio sweeps.
- **Client SDK** — a thin npm package wrapping key management and Conduit-specific headers.
- **More provider adapters** — Google, Cohere, Mistral, and self-hosted (vLLM/Ollama) endpoints.

---

## License

MIT.
# Conduit---LLM-Gateway-
