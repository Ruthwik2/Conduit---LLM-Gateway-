import type { FastifyReply, FastifyRequest } from "fastify";
import { toConduitError } from "../util/errors.js";

/** Pull the bearer token out of the Authorization header, if present. */
export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : header;
}

/** Send any error as an OpenAI-compatible error envelope with the right status. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const ce = toConduitError(err);
  return reply.code(ce.status).headers(ce.headers).send(ce.toEnvelope());
}
