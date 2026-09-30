import type { OpenAIErrorBody } from "../types/openai.js";

/**
 * Base class for all errors Conduit deliberately surfaces to the caller.
 * Every one knows its HTTP status and how to render itself as the OpenAI
 * error envelope, so client SDKs keep working unchanged.
 */
export class ConduitError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  /** Optional headers to attach to the response (e.g. Retry-After). */
  readonly headers: Record<string, string>;

  constructor(
    message: string,
    opts: {
      status: number;
      type: string;
      code?: string | null;
      param?: string | null;
      headers?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.type = opts.type;
    this.code = opts.code ?? null;
    this.param = opts.param ?? null;
    this.headers = opts.headers ?? {};
  }

  toEnvelope(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

export class AuthError extends ConduitError {
  constructor(message = "Invalid or missing API key.") {
    super(message, { status: 401, type: "invalid_request_error", code: "invalid_api_key" });
  }
}

export class ForbiddenModelError extends ConduitError {
  constructor(model: string) {
    super(`This key is not allowed to use model \`${model}\`.`, {
      status: 403,
      type: "invalid_request_error",
      code: "model_not_allowed",
      param: "model",
    });
  }
}

export class BudgetExceededError extends ConduitError {
  constructor(spent: number, cap: number) {
    super(
      `Budget exhausted: $${spent.toFixed(4)} of $${cap.toFixed(2)} cap used. Requests are blocked until the budget is raised or reset.`,
      { status: 402, type: "insufficient_quota", code: "budget_exceeded" },
    );
  }
}

export class RateLimitError extends ConduitError {
  constructor(retryAfterSeconds: number) {
    super("Rate limit exceeded for this key.", {
      status: 429,
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      headers: { "retry-after": String(Math.ceil(retryAfterSeconds)) },
    });
  }
}

export class NoRouteError extends ConduitError {
  constructor(model: string) {
    super(`No provider is configured for model \`${model}\`.`, {
      status: 400,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
}

export class ValidationError extends ConduitError {
  constructor(message: string, param: string | null = null) {
    super(message, { status: 400, type: "invalid_request_error", code: "invalid_request", param });
  }
}

/**
 * The downstream client hung up before we finished answering. Nobody is left to
 * receive a response, so this exists purely for internal bookkeeping: it must
 * never count against a provider's health (the provider did nothing wrong) and
 * is recorded with the conventional 499 "client closed request" status.
 */
export class ClientDisconnectedError extends ConduitError {
  constructor() {
    super("Client disconnected before the response completed.", {
      status: 499,
      type: "api_error",
      code: "client_disconnected",
    });
  }
}

/**
 * All upstream providers failed (or their circuits were open). This is the
 * "everything fell over" case; we report it as a 502 so callers can distinguish
 * gateway-level failure from their own bad request.
 */
export class UpstreamUnavailableError extends ConduitError {
  constructor(model: string, detail: string) {
    super(`All providers for \`${model}\` are unavailable. ${detail}`, {
      status: 502,
      type: "api_error",
      code: "upstream_unavailable",
    });
  }
}

/** Wrap an unknown thrown value into a ConduitError for uniform handling. */
export function toConduitError(err: unknown): ConduitError {
  if (err instanceof ConduitError) return err;
  const message = err instanceof Error ? err.message : "Internal server error.";
  return new ConduitError(message, { status: 500, type: "api_error", code: "internal_error" });
}
