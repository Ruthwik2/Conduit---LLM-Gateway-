import { z } from "zod";

/**
 * Mock provider behavior. Exported because the admin demo-control endpoint
 * validates against the SAME schema — one definition, so the config file and
 * the runtime control can never drift apart. `.strict()` so a typo'd field is
 * an error rather than a silently ignored no-op.
 */
export const mockBehaviorSchema = z
  .object({
    failWith: z
      .enum(["timeout", "rate_limit", "server_error", "connection", "client_error", "unknown"])
      .nullish(),
    failFirst: z.number().int().nonnegative().optional(),
    latencyMs: z.number().nonnegative().optional(),
    chunkDelayMs: z.number().nonnegative().optional(),
    reply: z.string().optional(),
  })
  .strict();

export const providerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai"),
    name: z.string().min(1),
    apiKey: z.string().min(1, "OpenAI provider requires an apiKey (use ${ENV_VAR})"),
    baseURL: z.string().url().optional(),
    vendor: z.string().optional(),
  }),
  z.object({
    type: z.literal("anthropic"),
    name: z.string().min(1),
    apiKey: z.string().min(1, "Anthropic provider requires an apiKey (use ${ENV_VAR})"),
    baseURL: z.string().url().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("mock"),
    name: z.string().min(1),
    vendor: z.string().optional(),
    behavior: mockBehaviorSchema.optional(),
  }),
]);

export const routeTargetSchema = z.object({
  provider: z.string().min(1),
  /** Model id to send upstream; defaults to the route's model id. */
  model: z.string().min(1).optional(),
});

export const routeSchema = z.object({
  model: z.string().min(1),
  targets: z.array(routeTargetSchema).min(1, "a route needs at least one target"),
});

export const circuitBreakerConfigSchema = z.object({
  /** Minimum calls in the window before the breaker may trip. */
  volumeThreshold: z.number().int().positive().default(5),
  /** Error rate (0..1) above which the breaker opens. */
  errorThreshold: z.number().min(0).max(1).default(0.5),
  /** Rolling window length, milliseconds. */
  windowMs: z.number().int().positive().default(30_000),
  /** How long the breaker stays open before probing again, milliseconds. */
  openStateMs: z.number().int().positive().default(15_000),
  /** Successful probes required in half-open before fully closing. */
  halfOpenSuccessThreshold: z.number().int().positive().default(2),
});

export const routerConfigSchema = z.object({
  /** Per-attempt upstream timeout, milliseconds. */
  timeoutMs: z.number().int().positive().default(30_000),
  /** Retries against the *same* provider before moving to the next target. */
  retriesPerTarget: z.number().int().nonnegative().default(1),
  backoff: z
    .object({
      baseMs: z.number().int().positive().default(200),
      maxMs: z.number().int().positive().default(2_000),
      jitter: z.boolean().default(true),
    })
    .default({}),
  circuitBreaker: circuitBreakerConfigSchema.default({}),
});

export const cacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * "shared": one cache for all virtual keys (max dedupe/savings — the default).
   * "per_key": entries are scoped to the key that created them, so one tenant's
   * answers are never replayed to another. Applies to both tiers.
   */
  scope: z.enum(["shared", "per_key"]).default("shared"),
  exact: z
    .object({
      enabled: z.boolean().default(true),
      ttlSeconds: z.number().int().positive().default(3600),
    })
    .default({}),
  semantic: z
    .object({
      enabled: z.boolean().default(true),
      ttlSeconds: z.number().int().positive().default(3600),
      similarityThreshold: z.number().min(0).max(1).default(0.92),
      embeddingModel: z.string().default("text-embedding-3-small"),
      /** Skip semantic caching above this temperature (answers diverge). */
      maxTemperature: z.number().min(0).max(2).default(0.5),
    })
    .default({}),
});

export const seedKeySchema = z.object({
  /** Plaintext key to register on boot — for local/demo use only. */
  key: z.string().min(8),
  name: z.string().min(1),
  budgetUsd: z.number().nonnegative().nullable().default(null),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().positive().default(60),
      burst: z.number().int().positive().optional(),
    })
    .default({}),
  allowedModels: z.array(z.string()).nullable().default(null),
});

export const storeConfigSchema = z.object({
  /** "memory" (single-process) or "redis". */
  backend: z.enum(["memory", "redis"]).default("memory"),
  redisUrl: z.string().optional(),
});

export const semanticStoreConfigSchema = z.object({
  backend: z.enum(["memory", "pgvector"]).default("memory"),
  databaseUrl: z.string().optional(),
});

export const embeddingsConfigSchema = z.object({
  /** "hash" = deterministic local embedder (no network); "openai" = real model. */
  backend: z.enum(["hash", "openai"]).default("hash"),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  model: z.string().default("text-embedding-3-small"),
  dimensions: z.number().int().positive().default(256),
});

export const serverConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().positive().default(8080),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  /** Bearer token guarding the /admin routes. */
  adminToken: z.string().min(1).default("dev-admin-token"),
  /** Expose the mock-control endpoint (demo only — never in prod). */
  enableDemoControls: z.boolean().default(false),
});

export const configSchema = z.object({
  server: serverConfigSchema.default({}),
  providers: z.array(providerConfigSchema).min(1, "configure at least one provider"),
  routes: z.array(routeSchema).min(1, "configure at least one route"),
  router: routerConfigSchema.default({}),
  cache: cacheConfigSchema.default({}),
  stores: storeConfigSchema.default({}),
  semanticStore: semanticStoreConfigSchema.default({}),
  embeddings: embeddingsConfigSchema.default({}),
  seedKeys: z.array(seedKeySchema).default([]),
});

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type CircuitBreakerConfig = z.infer<typeof circuitBreakerConfigSchema>;
export type CacheConfig = z.infer<typeof cacheConfigSchema>;
export type SeedKeyConfig = z.infer<typeof seedKeySchema>;
export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;
