# Improvements — 2026-07-05 review pass

A full review of the v1 codebase against the project spec. The architecture,
abstractions, and happy path were already in good shape, so nearly everything
below is about **failure paths** — the situations the demo doesn't show but
production hits weekly. All 67 pre-existing tests still pass; 17 tests were
added (84 total), plus a live smoke scenario that kills a real socket
mid-stream.

## Reliability & correctness

1. **Cache reads now fail open** (`pipeline.ts`). Previously a Redis, pgvector,
   or embeddings-API outage made `cache.lookup()` throw, turning *every*
   request into a 500 even though the providers were healthy — the cache, an
   optimization, could take down the data path. Lookups now degrade to a miss
   with a warning and a `conduit_cache_errors_total{stage="lookup"}` increment.
   Governance gates (auth / rate limit / budget) still deliberately fail
   *closed*.

2. **Accounting is non-fatal** (`pipeline.ts`). `addSpend`/metrics ran *after*
   a successful provider call but could still throw (e.g. a Redis blip),
   converting an already-answered, already-paid-for response into a caller
   error — or, on streams, an error frame after `[DONE]`. Accounting failures
   are now logged loudly (possible under-count) but never fail a served
   request.

3. **Interrupted streams are accounted** (`pipeline.ts`). If a client
   disconnected mid-stream or a provider died after the first byte, step 6
   never ran: no metrics, no usage record, no spend — invisible and unbillable.
   The provider loop now runs in `try/finally`; early endings are recorded with
   status **499** (client closed) or **502** (mid-stream failure), whatever
   usage the provider reported is billed, and partial answers are never written
   to the cache. Failed non-streaming requests are recorded too, so
   `conduit_requests_total{status=…}` finally reflects errors.

4. **Client disconnects no longer poison provider health** (`router.ts`). A
   client hang-up fired the shared abort signal, was classified as a provider
   *timeout*, counted against the circuit breaker, and emitted a failure
   metric — enough impatient clients could open a healthy provider's circuit.
   The router now detects `clientSignal.aborted` first and raises a dedicated
   `ClientDisconnectedError` (new, in `util/errors.ts`) that touches neither
   breaker state nor provider-failure metrics.

5. **Stream timeout is now time-to-first-byte** (`router.ts`). The per-attempt
   `AbortSignal.timeout(timeoutMs)` spanned the *entire* stream, so any
   generation longer than `timeoutMs` (default 30 s) was killed mid-flight. The
   timeout still catches an unresponsive provider, but is lifted once the first
   chunk arrives; timers and abort listeners are now explicitly disposed per
   attempt as well.

6. **Socket-safe, backpressured SSE pump** (`routes/chat.ts`). After
   `reply.hijack()` the raw response had no `'error'` listener (a disconnect's
   EPIPE could crash the process), writes weren't guarded against a destroyed
   socket, the pump never stopped when the client vanished, and `raw.write()`
   was never awaited — a burst (e.g. a cache replay) ballooned in memory for a
   slow client, and streams "completed" server-side before a disconnect could
   even land. The pump now swallows expected socket errors, checks
   `destroyed`/`writableEnded` before writing, pauses on `drain` (with a
   `close` escape so it can't hang), stops when the client is gone, and always
   disposes the generator so the pipeline's accounting `finally` runs.

7. **pgvector cache no longer grows forever** (`cache/semantic-store.ts`).
   Expired rows were filtered by queries but never deleted. `init()` now adds
   an `expires_at` index, prunes on boot, and starts an unref'd 5-minute prune
   timer (disposed on shutdown via a new optional `dispose()` on the store
   interface, called from `wiring.ts`). The in-memory store also drops expired
   rows on write, so write-only buckets stay bounded.

## Governance & security

8. **Per-key cache isolation option** (`cache.scope: shared | per_key`).
   By design the cache was shared across all virtual keys — maximum dedupe, but
   in a multi-tenant deployment one tenant's completions could be replayed to
   another. The default is unchanged (`shared`); `per_key` scopes both the
   exact key and the semantic bucket to the calling key
   (`config/schema.ts`, `cache/key.ts`, `cache/cache.ts`).

9. **Constant-time admin-token comparison** (`routes/admin.ts`). The admin
   bearer was checked with `!==`, a (theoretical) timing side-channel. Both
   sides are now SHA-256'd and compared with `crypto.timingSafeEqual`.

10. **Container hardening** (`Dockerfile`). The gateway now runs as the
    unprivileged `node` user, and dependencies install with `npm ci` against a
    committed `package-lock.json` for reproducible builds.

## Observability & DX

11. **New metric** `conduit_cache_errors_total{stage="lookup"|"store"}` makes
    fail-open degradation visible instead of silent.

12. **Real request IDs in usage records** — `usage.record` previously received
    an empty `requestId`.

13. **Mock provider `chunkDelayMs`** (config + demo-control endpoint): streams
    can now arrive paced like a real model instead of as an instantaneous
    burst — useful for demos and for exercising disconnect/timeout behavior.

14. **Single source of truth for the mock-behavior schema.** It was duplicated
    between `config/schema.ts` and `routes/admin.ts` and had already drifted;
    because the admin copy silently stripped unknown fields, a new knob could
    be silently ignored (this exact failure was caught during live testing).
    The admin route now imports the (strict) schema from `config/schema.ts`.

## Tests (67 → 84)

- `test/integration/resilience.test.ts` (new): cache fail-open with a dead
  exact store and a dead embedder; non-fatal accounting; TTFB stream-timeout
  semantics (long generations survive, first-byte timeouts still fail over);
  client-aborted and consumer-disposed streams recorded as 499 with untouched
  provider health; no cache poisoning from partial answers.
- `test/integration/cache-scope.test.ts` (new): `per_key` isolation across
  both tiers; `shared` default still dedupes across keys.
- `test/unit/semantic-store.test.ts` (new): expiry-on-write, never serving
  expired entries, best-live-match selection.
- `test/integration/failover.test.ts`: added streaming failover before the
  first byte (previously only the non-streaming path was covered).
- `test/unit/cache-key.test.ts`: scope participates in key/bucket derivation;
  empty scope is bit-identical to the legacy shared key.

## Verified

- `tsc --noEmit` clean; `vitest run` 84/84.
- Live smoke against a real server: cache tiers, streaming, admin auth, and a
  real socket killed mid-stream — process survives, the request is recorded as
  499, and the provider is not blamed.
- Load harness (`npm run bench`): throughput and latency in line with the
  documented baseline, zero non-2xx.
