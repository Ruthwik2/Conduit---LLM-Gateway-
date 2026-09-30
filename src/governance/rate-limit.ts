import type Redis from "ioredis";

export interface RateDecision {
  allowed: boolean;
  /** Whole tokens left in the bucket after this check. */
  remaining: number;
  /** If denied, milliseconds until one token is available again. */
  retryAfterMs: number;
}

export interface RateSpec {
  requestsPerMinute: number;
  burst: number;
}

export interface RateLimiter {
  check(keyId: string, spec: RateSpec): Promise<RateDecision>;
}

/** Idle buckets are forgotten after this many seconds to bound memory/keys. */
const BUCKET_TTL_SECONDS = 3600;

/**
 * Classic token bucket: the bucket holds up to `burst` tokens and refills at
 * `requestsPerMinute / 60s`. Each request consumes one token; an empty bucket
 * means the caller is over their rate and is told when to retry. Bursts up to
 * capacity are allowed, while the long-run average is held to the configured
 * rate.
 */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { tokens: number; ts: number }>();

  constructor(private now: () => number = Date.now) {}

  async check(keyId: string, spec: RateSpec): Promise<RateDecision> {
    const ratePerMs = spec.requestsPerMinute / 60_000;
    const now = this.now();
    const state = this.buckets.get(keyId) ?? { tokens: spec.burst, ts: now };

    const elapsed = Math.max(0, now - state.ts);
    let tokens = Math.min(spec.burst, state.tokens + elapsed * ratePerMs);

    let allowed = false;
    let retryAfterMs = 0;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = true;
    } else {
      retryAfterMs = Math.ceil((1 - tokens) / ratePerMs);
    }

    this.buckets.set(keyId, { tokens, ts: now });
    return { allowed, remaining: Math.floor(tokens), retryAfterMs };
  }
}

/**
 * Distributed token bucket. The refill-and-consume step runs as a single Lua
 * script so concurrent requests across replicas can't race the counter. We pass
 * the current time in from the app rather than reading Redis TIME — one fewer
 * round trip, and it keeps the limiter unit-testable with an injected clock.
 */
export class RedisRateLimiter implements RateLimiter {
  private prefix = "conduit:ratelimit:";

  // KEYS[1]=bucket  ARGV: ratePerMs, burst, now(ms), cost, ttl(s)
  private static readonly SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local d = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = burst; ts = now end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate)
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttl * 1000)
return {allowed, math.floor(tokens), retry}
`;

  constructor(
    private redis: Redis,
    private now: () => number = Date.now,
  ) {}

  async check(keyId: string, spec: RateSpec): Promise<RateDecision> {
    const ratePerMs = spec.requestsPerMinute / 60_000;
    const res = (await this.redis.eval(
      RedisRateLimiter.SCRIPT,
      1,
      this.prefix + keyId,
      String(ratePerMs),
      String(spec.burst),
      String(this.now()),
      "1",
      String(BUCKET_TTL_SECONDS),
    )) as [number, number, number];

    return { allowed: res[0] === 1, remaining: res[1], retryAfterMs: res[2] };
  }
}
