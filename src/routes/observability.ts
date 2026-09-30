import type { FastifyInstance } from "fastify";
import type { Container } from "../wiring.js";

/** /metrics (Prometheus), liveness/readiness probes, and a status view. */
export function registerObservabilityRoutes(app: FastifyInstance, container: Container): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", container.metrics.contentType);
    return reply.send(await container.metrics.render());
  });

  app.get("/healthz", async (_req, reply) => reply.send({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => reply.send({ status: "ready" }));

  /**
   * Human-friendly status: current circuit-breaker state per provider plus the
   * advertised models. Read-only and unauthenticated — handy for the live demo
   * to show a provider's circuit opening in real time.
   */
  app.get("/status", async (_req, reply) =>
    reply.send({
      service: "conduit",
      models: container.registry.routeModels(),
      circuits: container.circuits.snapshots(),
    }),
  );
}
