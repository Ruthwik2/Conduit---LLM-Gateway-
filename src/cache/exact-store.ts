import type Redis from "ioredis";
import type { ChatCompletionResponse } from "../types/openai.js";

/** A cached completion plus the moment it was first stored. */
export interface ExactCacheEntry {
  response: ChatCompletionResponse;
  storedAt: number;
}

export interface ExactStore {
  get(key: string): Promise<ExactCacheEntry | null>;
  set(key: string, response: ChatCompletionResponse, ttlSeconds: number): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Single-process exact store. Backed by a Map with lazy TTL expiry (entries are
 * checked on read and dropped when stale). Fine for local runs, tests, and
 * single-instance deployments; use Redis when running more than one replica.
 */
export class MemoryExactStore implements ExactStore {
  private map = new Map<string, { entry: ExactCacheEntry; expiresAt: number }>();

  constructor(private now: () => number = Date.now) {}

  async get(key: string): Promise<ExactCacheEntry | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.entry;
  }

  async set(key: string, response: ChatCompletionResponse, ttlSeconds: number): Promise<void> {
    this.map.set(key, {
      entry: { response, storedAt: this.now() },
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

/** Redis-backed exact store. Keys are namespaced and expire via Redis TTL. */
export class RedisExactStore implements ExactStore {
  constructor(
    private redis: Redis,
    private prefix = "conduit:cache:exact:",
  ) {}

  async get(key: string): Promise<ExactCacheEntry | null> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ExactCacheEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, response: ChatCompletionResponse, ttlSeconds: number): Promise<void> {
    const entry: ExactCacheEntry = { response, storedAt: Date.now() };
    await this.redis.set(this.prefix + key, JSON.stringify(entry), "EX", ttlSeconds);
  }

  async clear(): Promise<void> {
    // Scan-and-delete only within our namespace; never FLUSHDB a shared Redis.
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 200);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== "0");
  }
}
