import { pino, type Logger } from "pino";

export type { Logger };

/**
 * Create the root logger. In a TTY we pretty-print for readability; otherwise we
 * emit line-delimited JSON, which is what log shippers expect in production.
 */
export function createLogger(level: string): Logger {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== "production";
  return pino({
    level,
    base: { service: "conduit" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service" },
          },
        }
      : {}),
  });
}

/** A per-request child logger carrying the request id (and key id when known). */
export function requestLogger(root: Logger, fields: { requestId: string; keyId?: string }): Logger {
  return root.child(fields);
}
