import type { FailureKind } from "../types/internal.js";

/**
 * A normalized provider failure. The router cares about three things:
 *   - `retriable`: should we fail over to another provider?
 *   - `countsAgainstHealth`: should this trip the provider's circuit breaker?
 *   - `kind`: for metrics + logs.
 *
 * The key insight: a 4xx that is the *caller's* fault (bad request, context too
 * long) is NOT the provider's fault. Failing over would just reproduce the same
 * error on the backup and wrongly mark a healthy provider as sick. So those are
 * neither retriable nor counted against health.
 */
export class ProviderError extends Error {
  readonly kind: FailureKind;
  readonly retriable: boolean;
  readonly countsAgainstHealth: boolean;
  readonly status: number | undefined;
  readonly provider: string;

  constructor(opts: {
    message: string;
    kind: FailureKind;
    retriable: boolean;
    countsAgainstHealth: boolean;
    provider: string;
    status?: number;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.kind = opts.kind;
    this.retriable = opts.retriable;
    this.countsAgainstHealth = opts.countsAgainstHealth;
    this.status = opts.status;
    this.provider = opts.provider;
  }
}

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.code === "string") return e.code;
    const cause = e.cause;
    if (typeof cause === "object" && cause !== null) {
      const c = (cause as Record<string, unknown>).code;
      if (typeof c === "string") return c;
    }
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /aborted|abort signal|timed? ?out/i.test(err.message))
  );
}

/**
 * Map any thrown value from a provider SDK / fetch into a {@link ProviderError}.
 */
export function classifyProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;

  const status = statusOf(err);
  const code = codeOf(err);
  const message = err instanceof Error ? err.message : String(err);

  if (isAbort(err)) {
    return new ProviderError({
      message: `Request to ${provider} timed out or was aborted: ${message}`,
      kind: "timeout",
      retriable: true,
      countsAgainstHealth: true,
      provider,
      status,
      cause: err,
    });
  }

  if (status === 429) {
    return new ProviderError({
      message: `${provider} rate-limited the request (429).`,
      kind: "rate_limit",
      retriable: true,
      countsAgainstHealth: true,
      provider,
      status,
      cause: err,
    });
  }

  if (status !== undefined && status >= 500) {
    return new ProviderError({
      message: `${provider} returned a server error (${status}).`,
      kind: "server_error",
      retriable: true,
      countsAgainstHealth: true,
      provider,
      status,
      cause: err,
    });
  }

  if (status === 408) {
    return new ProviderError({
      message: `${provider} reported a request timeout (408).`,
      kind: "timeout",
      retriable: true,
      countsAgainstHealth: true,
      provider,
      status,
      cause: err,
    });
  }

  if (status !== undefined && status >= 400) {
    // Caller's fault — do not fail over, do not blame the provider.
    return new ProviderError({
      message: `${provider} rejected the request (${status}): ${message}`,
      kind: "client_error",
      retriable: false,
      countsAgainstHealth: false,
      provider,
      status,
      cause: err,
    });
  }

  if (code && CONNECTION_CODES.has(code)) {
    return new ProviderError({
      message: `Could not reach ${provider} (${code}).`,
      kind: "connection",
      retriable: true,
      countsAgainstHealth: true,
      provider,
      status,
      cause: err,
    });
  }

  // Unknown: be conservative — allow failover, and count it so a provider that
  // throws mysterious errors eventually gets shed.
  return new ProviderError({
    message: `Unexpected error from ${provider}: ${message}`,
    kind: "unknown",
    retriable: true,
    countsAgainstHealth: true,
    provider,
    status,
    cause: err,
  });
}
