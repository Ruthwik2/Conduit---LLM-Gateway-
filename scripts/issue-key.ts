import "dotenv/config";
import { loadConfig } from "../src/config/index.js";
import { buildContainer } from "../src/wiring.js";

/**
 * Issue a virtual key from the command line.
 *
 *   npm run keygen -- --name "team-search" --budget 25 --rpm 120 --models gpt-4o-mini,demo-model
 *
 * Note: keys persist only in a durable backend (Redis). With the default
 * in-memory store the key is printed but gone on restart — use `seedKeys` in
 * the config for local/demo persistence.
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig({ allowDefault: true });
  const container = buildContainer(config);
  await container.init();

  const name = arg("--name") ?? "cli-key";
  const budget = arg("--budget");
  const rpm = arg("--rpm");
  const models = arg("--models");

  const { key, secret } = await container.keys.create({
    name,
    budgetUsd: budget !== undefined ? Number(budget) : null,
    rateLimit: rpm !== undefined ? { requestsPerMinute: Number(rpm) } : undefined,
    allowedModels: models ? models.split(",").map((m) => m.trim()) : null,
  });

  // Plain stdout (not the logger) so the secret is easy to capture in scripts.
  process.stdout.write(
    JSON.stringify(
      {
        id: key.id,
        name: key.name,
        key: secret,
        budgetUsd: key.budgetUsd,
        rateLimit: key.rateLimit,
        allowedModels: key.allowedModels,
        backend: config.stores.backend,
      },
      null,
      2,
    ) + "\n",
  );

  if (config.stores.backend === "memory") {
    process.stderr.write(
      "\n[warn] stores.backend is 'memory' — this key will not survive a restart.\n",
    );
  }

  await container.close();
}

void main();
