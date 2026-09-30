import { customAlphabet, nanoid } from "nanoid";

const base62 = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  24,
);

/** OpenAI-style completion id, e.g. `chatcmpl-abc123...`. */
export function chatCompletionId(): string {
  return `chatcmpl-${base62()}`;
}

/** Correlation id attached to every request and every log line. */
export function requestId(): string {
  return `req_${base62()}`;
}

/**
 * A virtual key: public prefix `ck-` + secret body. Only a SHA-256 hash of the
 * whole thing is ever persisted (see auth/key-store).
 */
export function generateVirtualKey(): string {
  return `ck-${nanoid(40)}`;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
