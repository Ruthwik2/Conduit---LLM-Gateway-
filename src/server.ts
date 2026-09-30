import "dotenv/config";
import { loadConfig } from "./config/index.js";
import { buildContainer } from "./wiring.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig({ allowDefault: true });
  const container = buildContainer(config);
  const { logger } = container;

  await container.init();

  const app = buildApp(container);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      await container.close();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    logger.info(
      {
        url: `http://${config.server.host}:${config.server.port}`,
        backends: {
          stores: config.stores.backend,
          semantic: config.semanticStore.backend,
          embeddings: config.embeddings.backend,
        },
        models: container.registry.routeModels(),
      },
      "conduit is listening",
    );
  } catch (err) {
    logger.error({ err }, "failed to start");
    await container.close();
    process.exit(1);
  }
}

void main();
