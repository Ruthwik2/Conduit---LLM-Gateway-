import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Config, configSchema } from "./schema.js";

/**
 * Recursively replace `${ENV_VAR}` references inside string values with the
 * corresponding environment variable, so secrets live in the environment and
 * never in the committed YAML. An unset referenced var becomes "" and is then
 * caught by schema validation with a clear message.
 */
function substituteEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

/**
 * A zero-config default: two mock providers (a primary and a fallback) plus a
 * seed key, so `docker compose up` — or `npm start` with no config at all —
 * produces a working gateway you can curl immediately, with no API keys.
 */
export function defaultConfig(): Config {
  return configSchema.parse({
    server: {
      port: Number(process.env.PORT ?? 8080),
      logLevel: process.env.LOG_LEVEL ?? "info",
      adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
      enableDemoControls: true,
    },
    providers: [
      { type: "mock", name: "mock-primary", behavior: { latencyMs: 40 } },
      { type: "mock", name: "mock-fallback", behavior: { latencyMs: 60 } },
    ],
    routes: [
      {
        model: "gpt-4o-mini",
        targets: [{ provider: "mock-primary" }, { provider: "mock-fallback" }],
      },
      {
        model: "demo-model",
        targets: [{ provider: "mock-primary" }, { provider: "mock-fallback" }],
      },
    ],
    stores: {
      backend: process.env.REDIS_URL ? "redis" : "memory",
      redisUrl: process.env.REDIS_URL,
    },
    semanticStore: {
      backend: process.env.DATABASE_URL ? "pgvector" : "memory",
      databaseUrl: process.env.DATABASE_URL,
    },
    embeddings: {
      backend: process.env.OPENAI_API_KEY ? "openai" : "hash",
      apiKey: process.env.OPENAI_API_KEY,
    },
    seedKeys: [
      {
        key: process.env.DEMO_KEY ?? "ck-demo-0000000000000000000000000000",
        name: "demo",
        budgetUsd: 5,
        rateLimit: { requestsPerMinute: 120 },
        allowedModels: null,
      },
    ],
  });
}

export interface LoadConfigOptions {
  /** Explicit path; otherwise CONDUIT_CONFIG env, then ./config/conduit.yaml. */
  path?: string;
  /** If true and no file is found, fall back to {@link defaultConfig}. */
  allowDefault?: boolean;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const path = opts.path ?? process.env.CONDUIT_CONFIG ?? resolve(process.cwd(), "config/conduit.yaml");

  if (!existsSync(path)) {
    if (opts.allowDefault !== false) return defaultConfig();
    throw new Error(`Config file not found at ${path}`);
  }

  const raw = parseYaml(readFileSync(path, "utf8"));
  const substituted = substituteEnv(raw);

  const obj = (substituted ?? {}) as Record<string, unknown>;
  const result = configSchema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Conduit config (${path}):\n${issues}`);
  }

  // Apply a few top-level env overrides so deployments can tune without editing YAML.
  const config = result.data;
  if (process.env.PORT) config.server.port = Number(process.env.PORT);
  if (process.env.LOG_LEVEL) config.server.logLevel = process.env.LOG_LEVEL as Config["server"]["logLevel"];
  if (process.env.ADMIN_TOKEN) config.server.adminToken = process.env.ADMIN_TOKEN;
  if (process.env.REDIS_URL) {
    config.stores.backend = "redis";
    config.stores.redisUrl = process.env.REDIS_URL;
  }
  if (process.env.DATABASE_URL) {
    config.semanticStore.backend = "pgvector";
    config.semanticStore.databaseUrl = process.env.DATABASE_URL;
  }
  return config;
}
