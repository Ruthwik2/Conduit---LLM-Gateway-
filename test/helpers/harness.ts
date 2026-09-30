import type { FastifyInstance } from "fastify";
import { configSchema, type Config } from "../../src/config/schema.js";
import { buildContainer, type Container } from "../../src/wiring.js";
import { buildApp } from "../../src/app.js";
import { createLogger } from "../../src/telemetry/logger.js";

export const TEST_KEY = "ck-test-key-0000000000000000000000";
export const ADMIN_TOKEN = "test-admin-token";

/**
 * A deep-ish partial: enough to let tests pass just the slice of config they
 * care about. The base is a fully in-memory, network-free gateway with two mock
 * providers behind one route, so every test runs with no external services.
 */
export type ConfigOverrides = Record<string, unknown>;

function baseConfigInput(overrides: ConfigOverrides = {}): unknown {
  return {
    server: {
      host: "127.0.0.1",
      port: 8080,
      logLevel: "silent",
      adminToken: ADMIN_TOKEN,
      enableDemoControls: true,
    },
    providers: [
      { type: "mock", name: "mock-primary" },
      { type: "mock", name: "mock-fallback" },
    ],
    routes: [
      {
        model: "gpt-4o-mini",
        targets: [{ provider: "mock-primary" }, { provider: "mock-fallback" }],
      },
    ],
    seedKeys: [
      {
        key: TEST_KEY,
        name: "test",
        budgetUsd: 100,
        rateLimit: { requestsPerMinute: 10_000, burst: 10_000 },
      },
    ],
    // Memory/hash backends are the schema defaults — no need to set them.
    ...overrides,
  };
}

export function makeConfig(overrides: ConfigOverrides = {}): Config {
  return configSchema.parse(baseConfigInput(overrides));
}

export interface Harness {
  app: FastifyInstance;
  container: Container;
  /** Convenience: set behavior on a named mock provider. */
  mock(name: string): {
    fail(kind?: string): void;
    failFirst(n: number, kind?: string): void;
    recover(): void;
    reply(text: string): void;
  };
  close(): Promise<void>;
}

/**
 * Build a fully wired, in-memory gateway and its HTTP app, ready for
 * `app.inject(...)`. No sockets are opened and no external services are needed.
 */
export async function makeHarness(overrides: ConfigOverrides = {}): Promise<Harness> {
  const config = makeConfig(overrides);
  const logger = createLogger("silent");
  const container = buildContainer(config, logger);
  await container.init();
  const app = buildApp(container);
  await app.ready();

  return {
    app,
    container,
    mock(name: string) {
      const m = container.registry.findMock(name);
      if (!m) throw new Error(`no mock provider named ${name}`);
      return {
        fail(kind = "server_error") {
          m.setBehavior({ failWith: kind as never });
        },
        failFirst(n: number, kind = "server_error") {
          m.setBehavior({ failFirst: n, failWith: kind as never });
        },
        recover() {
          m.setBehavior({ failWith: null, failFirst: 0 });
        },
        reply(text: string) {
          m.setBehavior({ reply: text });
        },
      };
    },
    async close() {
      await app.close();
      await container.close();
    },
  };
}

/** Standard auth header for the seeded test key. */
export function authHeader(secret: string = TEST_KEY): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

export function adminHeader(token: string = ADMIN_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
