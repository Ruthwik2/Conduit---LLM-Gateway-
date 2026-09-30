import Redis from "ioredis";
import { Pool } from "pg";
import type { Config } from "./config/schema.js";
import { createLogger, type Logger } from "./telemetry/logger.js";
import { Metrics } from "./telemetry/metrics.js";

import { buildEmbedder } from "./cache/embeddings.js";
import { MemoryExactStore, RedisExactStore, type ExactStore } from "./cache/exact-store.js";
import {
  MemorySemanticStore,
  PgVectorSemanticStore,
  type SemanticStore,
} from "./cache/semantic-store.js";
import { CacheService } from "./cache/cache.js";

import { MemoryKeyStore, RedisKeyStore, type KeyStore } from "./auth/key-store.js";
import {
  MemoryRateLimiter,
  RedisRateLimiter,
  type RateLimiter,
} from "./governance/rate-limit.js";
import { MemoryBudgetStore, RedisBudgetStore, type BudgetStore } from "./governance/budget.js";

import { ProviderRegistry } from "./providers/registry.js";
import { CircuitBreakerRegistry } from "./router/circuit-breaker.js";
import { Router } from "./router/router.js";
import { UsageAggregator } from "./accounting/usage.js";
import { Pipeline } from "./pipeline/pipeline.js";

export interface Container {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  pipeline: Pipeline;
  cache: CacheService;
  keys: KeyStore;
  budget: BudgetStore;
  usage: UsageAggregator;
  registry: ProviderRegistry;
  circuits: CircuitBreakerRegistry;
  /** Seed keys + initialize the semantic store schema. Call once at startup. */
  init(): Promise<void>;
  /** Tear down external connections (Redis, Postgres). */
  close(): Promise<void>;
}

/**
 * Assemble the whole gateway from a validated config. Storage backends are
 * selected here — the rest of the code only ever sees interfaces — so the exact
 * same wiring runs in-memory for local/dev/test and against Redis + pgvector in
 * Docker, chosen purely by config.
 */
export function buildContainer(config: Config, externalLogger?: Logger): Container {
  const logger = externalLogger ?? createLogger(config.server.logLevel);
  const metrics = new Metrics();

  // Shared external clients, created only when a backend needs them.
  let redis: Redis | null = null;
  let pg: Pool | null = null;

  const needRedis = config.stores.backend === "redis";
  if (needRedis) {
    const url = config.stores.redisUrl ?? "redis://127.0.0.1:6379";
    redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    redis.on("error", (err) => logger.error({ err }, "redis error"));
  }

  const needPg = config.semanticStore.backend === "pgvector";
  if (needPg) {
    const connectionString = config.semanticStore.databaseUrl ?? process.env.DATABASE_URL;
    pg = new Pool({ connectionString, max: 8 });
    pg.on("error", (err) => logger.error({ err }, "postgres pool error"));
  }

  // Cache tier.
  const embedder = buildEmbedder(config.embeddings);
  const exact: ExactStore =
    config.stores.backend === "redis" && redis
      ? new RedisExactStore(redis)
      : new MemoryExactStore();
  const semantic: SemanticStore =
    config.semanticStore.backend === "pgvector" && pg
      ? new PgVectorSemanticStore(pg, config.embeddings.dimensions)
      : new MemorySemanticStore();
  const cache = new CacheService(config.cache, exact, semantic, embedder);

  // Auth + governance.
  const keys: KeyStore =
    config.stores.backend === "redis" && redis ? new RedisKeyStore(redis) : new MemoryKeyStore();
  const rateLimiter: RateLimiter =
    config.stores.backend === "redis" && redis
      ? new RedisRateLimiter(redis)
      : new MemoryRateLimiter();
  const budget: BudgetStore =
    config.stores.backend === "redis" && redis
      ? new RedisBudgetStore(redis)
      : new MemoryBudgetStore();

  // Routing + resilience.
  const registry = new ProviderRegistry(config);
  const circuits = new CircuitBreakerRegistry(config.router.circuitBreaker);
  const router = new Router(registry, config.router, circuits, metrics);
  metrics.bindCircuitSource(() => circuits.snapshots());

  const usage = new UsageAggregator();

  const pipeline = new Pipeline({
    keys,
    rateLimiter,
    budget,
    cache,
    registry,
    router,
    usage,
    metrics,
    logger,
  });

  return {
    config,
    logger,
    metrics,
    pipeline,
    cache,
    keys,
    budget,
    usage,
    registry,
    circuits,

    async init() {
      await semantic.init();
      for (const seed of config.seedKeys) {
        const key = await keys.registerSecret(seed.key, {
          name: seed.name,
          budgetUsd: seed.budgetUsd,
          rateLimit: seed.rateLimit,
          allowedModels: seed.allowedModels,
        });
        logger.info(
          { keyId: key.id, name: key.name, display: key.display, budgetUsd: key.budgetUsd },
          "seeded virtual key",
        );
      }
    },

    async close() {
      semantic.dispose?.();
      if (redis) await redis.quit().catch(() => redis!.disconnect());
      if (pg) await pg.end().catch(() => undefined);
    },
  };
}
