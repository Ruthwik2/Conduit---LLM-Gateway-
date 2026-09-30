import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Container } from "../wiring.js";
import { mockBehaviorSchema } from "../config/schema.js";
import type { VirtualKey } from "../auth/virtual-key.js";
import { AuthError, ValidationError } from "../util/errors.js";
import { bearerToken, sendError } from "./util.js";

const createKeySchema = z.object({
  name: z.string().min(1),
  budgetUsd: z.number().nonnegative().nullable().optional(),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().positive(),
      burst: z.number().int().positive().optional(),
    })
    .optional(),
  allowedModels: z.array(z.string()).nullable().optional(),
});

/** Public projection of a key — never includes the secret or its hash. */
function publicKey(k: VirtualKey) {
  return {
    id: k.id,
    name: k.name,
    display: k.display,
    budgetUsd: k.budgetUsd,
    rateLimit: k.rateLimit,
    allowedModels: k.allowedModels,
    createdAt: k.createdAt,
    disabled: k.disabled,
  };
}

/**
 * Constant-time bearer comparison. Hashing both sides first gives equal-length
 * buffers, so neither content nor length differences shape the timing.
 */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerAdminRoutes(app: FastifyInstance, container: Container): void {
  const adminToken = container.config.server.adminToken;

  /** Reject unless the caller presents the admin bearer token. */
  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!tokenMatches(bearerToken(req), adminToken)) {
      sendError(reply, new AuthError("Admin token required."));
      return false;
    }
    return true;
  }

  app.post("/admin/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendError(reply, new ValidationError(issue?.message ?? "Invalid body."));
    }
    const { key, secret } = await container.keys.create({
      name: parsed.data.name,
      budgetUsd: parsed.data.budgetUsd ?? null,
      rateLimit: parsed.data.rateLimit,
      allowedModels: parsed.data.allowedModels ?? null,
    });
    container.logger.info({ keyId: key.id, name: key.name }, "virtual key created");
    // The secret is returned exactly once — clients must store it now.
    return reply.code(201).send({ ...publicKey(key), key: secret });
  });

  app.get("/admin/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const keys = await container.keys.list();
    return reply.send({ data: keys.map(publicKey) });
  });

  app.delete<{ Params: { id: string } }>("/admin/keys/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ok = await container.keys.revoke(req.params.id);
    if (!ok) return sendError(reply, new ValidationError(`No such key: ${req.params.id}`));
    return reply.send({ id: req.params.id, revoked: true });
  });

  app.get<{ Params: { id: string } }>("/admin/keys/:id/usage", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const key = await container.keys.getById(req.params.id);
    if (!key) return sendError(reply, new ValidationError(`No such key: ${req.params.id}`));
    const spent = await container.budget.getSpend(key.id);
    const summary = container.usage.forKey(key.id);
    return reply.send({
      key: publicKey(key),
      spendUsd: spent,
      budgetUsd: key.budgetUsd,
      remainingUsd: key.budgetUsd === null ? null : Math.max(0, key.budgetUsd - spent),
      usage: summary,
    });
  });

  app.get("/admin/usage", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return reply.send({ data: container.usage.all() });
  });

  // ---- Demo control: drive a mock provider's behavior at runtime ----
  // Guarded by BOTH the admin token and the explicit demo-controls flag, so it
  // can never be toggled on by accident in a real deployment.
  app.post<{ Params: { name: string } }>("/admin/mock/:name/behavior", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!container.config.server.enableDemoControls) {
      return sendError(reply, new ValidationError("Demo controls are disabled."));
    }
    const mock = container.registry.findMock(req.params.name);
    if (!mock) return sendError(reply, new ValidationError(`No mock provider named ${req.params.name}`));
    const parsed = mockBehaviorSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendError(reply, new ValidationError(issue?.message ?? "Invalid behavior."));
    }
    mock.setBehavior(parsed.data);
    container.logger.warn({ provider: req.params.name, behavior: parsed.data }, "mock behavior changed");
    return reply.send({ provider: req.params.name, behavior: mock.getBehavior() });
  });
}
