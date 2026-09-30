import type { FastifyInstance } from "fastify";
import type { Container } from "../wiring.js";
import { unixSeconds } from "../util/id.js";
import type { ModelObject } from "../types/openai.js";

/**
 * OpenAI-compatible model list. We advertise the models the gateway is
 * configured to route, so client tooling that calls `/v1/models` (and SDK
 * `models.list()`) works unchanged.
 */
export function registerModelsRoute(app: FastifyInstance, container: Container): void {
  app.get("/v1/models", async (_req, reply) => {
    const created = unixSeconds();
    const data: ModelObject[] = container.registry.routeModels().map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "conduit",
    }));
    return reply.send({ object: "list", data });
  });
}
