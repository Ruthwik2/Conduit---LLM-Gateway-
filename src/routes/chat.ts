import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../wiring.js";
import { chatCompletionRequestSchema } from "../types/openai.js";
import { ValidationError } from "../util/errors.js";
import { requestId as makeRequestId } from "../util/id.js";
import { sseFrame } from "../util/sse.js";
import { bearerToken, sendError } from "./util.js";
import type { RequestCtx } from "../pipeline/pipeline.js";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no", // tell nginx not to buffer the stream
};

/**
 * Build an AbortSignal that fires if the client hangs up before we finish. This
 * is what lets the router cancel the upstream provider call when nobody is left
 * to read the answer — so we stop generating (and paying for) tokens.
 *
 * We listen on the *response* socket, not the request stream. The request stream
 * emits "close" as soon as the body has been fully read — which for a normal
 * request happens long before we've produced an answer — so keying off it would
 * abort every healthy call. The response emits "close" either when we've flushed
 * the full reply (writableFinished === true → nothing to cancel) or when the
 * connection dropped early (writableFinished === false → the client is gone).
 */
function clientAbortSignal(_req: FastifyRequest, reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return ac.signal;
}

export function registerChatRoute(app: FastifyInstance, container: Container): void {
  app.post("/v1/chat/completions", async (req, reply) => {
    const parsed = chatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const msg = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body.";
      return sendError(reply, new ValidationError(msg, issue?.path.join(".") || null));
    }

    const body = parsed.data;
    const ctx: RequestCtx = {
      requestId: makeRequestId(),
      secret: bearerToken(req),
      clientSignal: clientAbortSignal(req, reply),
    };

    reply.header("x-conduit-request-id", ctx.requestId);

    if (!body.stream) {
      try {
        const out = await container.pipeline.complete(body, ctx);
        reply
          .header("x-conduit-cache", out.outcome === "provider" ? "miss" : out.outcome.replace("cache_", ""))
          .header("x-conduit-provider", out.provider ?? "none");
        return reply.send(out.response);
      } catch (err) {
        return sendError(reply, err);
      }
    }

    // Streaming. We pull the first item *before* committing to a 200 so that
    // auth/budget/rate-limit failures (which throw before any byte is yielded)
    // still surface as proper HTTP error responses instead of a broken stream.
    const iterator = container.pipeline.stream(body, ctx)[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (err) {
      return sendError(reply, err);
    }

    reply.hijack();
    const raw = reply.raw;
    // A disconnecting client surfaces as an 'error' on the response stream
    // (EPIPE/ECONNRESET). Left unhandled it would crash the process; the abort
    // signal above is how we react, so the event itself is expected noise.
    raw.on("error", () => {});
    raw.writeHead(200, {
      ...SSE_HEADERS,
      "x-conduit-request-id": ctx.requestId,
    });

    /** Resolve when the socket can take more data — or when it's gone. */
    const waitWritable = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          raw.off("drain", done);
          raw.off("close", done);
          resolve();
        };
        raw.once("drain", done);
        raw.once("close", done);
      });

    /**
     * Write a frame with backpressure: when the socket buffer is full we pause
     * until it drains, so a slow client paces the pump instead of the whole
     * response ballooning in memory. Returns false once the client is gone.
     */
    const send = async (frame: string): Promise<boolean> => {
      if (raw.destroyed || raw.writableEnded) return false;
      if (!raw.write(frame)) await waitWritable();
      return true;
    };

    try {
      if (!first.done) await send(first.value);
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        // Client hung up → stop pumping. Disposing the iterator (below) runs the
        // pipeline's finally block, which cancels upstream and records the
        // partial delivery.
        if (!(await send(next.value))) break;
      }
    } catch (err) {
      // Mid-stream failure (already past the first byte): emit a final error
      // frame so the client sees a structured error rather than a silent cut.
      const { toConduitError, ClientDisconnectedError } = await import("../util/errors.js");
      await send(sseFrame(toConduitError(err).toEnvelope()));
      if (err instanceof ClientDisconnectedError) {
        container.logger.info({ requestId: ctx.requestId }, "client disconnected mid-stream");
      } else {
        container.logger.error({ err, requestId: ctx.requestId }, "stream interrupted after first byte");
      }
    } finally {
      // Always dispose the generator so the pipeline's finally (accounting,
      // upstream cleanup) runs even when we exited the loop early.
      try {
        await iterator.return?.(undefined as never);
      } catch {
        // Disposal errors have nowhere useful to go.
      }
      if (!raw.destroyed && !raw.writableEnded) raw.end();
    }
  });
}
