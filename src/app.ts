import Fastify, { type FastifyInstance } from "fastify";
import type { Container } from "./wiring.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { sendError } from "./routes/util.js";

/**
 * Construct the HTTP app around an already-built container. Kept separate from
 * `server.ts` so integration tests can spin up the full app with an in-memory
 * container and hit it via `app.inject(...)` — no sockets, no Docker.
 */
export function buildApp(container: Container): FastifyInstance {
  const app = Fastify({
    logger: false, // we log through our own pino instance
    bodyLimit: 8 * 1024 * 1024, // generous headroom for large prompts
    disableRequestLogging: true,
  });

  registerChatRoute(app, container);
  registerModelsRoute(app, container);
  registerAdminRoutes(app, container);
  registerObservabilityRoutes(app, container);

  // Unknown routes → OpenAI-shaped 404 so clients' error handling still applies.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: {
        message: `Unknown route: ${req.method} ${req.url}`,
        type: "invalid_request_error",
        param: null,
        code: "not_found",
      },
    });
  });

  // Any uncaught error → OpenAI-shaped envelope. 4xx framework errors (bad JSON,
  // unsupported media type) keep their status; everything else is a 500.
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    const statusCode = e.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          message: e.message ?? "Bad request.",
          type: "invalid_request_error",
          param: null,
          code: e.code ?? null,
        },
      });
    }
    container.logger.error({ err }, "unhandled error");
    return sendError(reply, err);
  });

  return app;
}
