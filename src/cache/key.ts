import { createHash } from "node:crypto";
import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js";

/**
 * Fields that actually change the model's output. Everything else in the
 * request (stream, stream_options, user, n display prefs, etc.) is deliberately
 * excluded so that two requests that differ only in transport details still
 * share a cache entry.
 */
const ANSWER_AFFECTING_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "seed",
  "tools",
  "tool_choice",
  "response_format",
] as const;

/** Flatten message content (string or array parts) into plain text. */
function messageText(msg: ChatMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(part);
      })
      .join(" ");
  }
  return "";
}

/** Canonical, stable representation of the answer-affecting request shape. */
function canonical(req: ChatCompletionRequest, scope: string): string {
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: messageText(m).trim(),
    ...(m.name ? { name: m.name } : {}),
  }));

  const params: Record<string, unknown> = {};
  for (const key of ANSWER_AFFECTING_KEYS) {
    const val = (req as Record<string, unknown>)[key];
    if (val !== undefined) params[key] = val;
  }

  // JSON.stringify with sorted keys gives a stable string regardless of the
  // order fields arrived in. `scope` (empty for a shared cache, the key id for
  // per-key isolation) participates so scoped tenants never share entries.
  return stableStringify({ model: req.model, messages, params, ...(scope ? { scope } : {}) });
}

/** Deterministic JSON: object keys are emitted in sorted order, recursively. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * SHA-256 of the canonical request shape. Two requests collide here iff they
 * would produce the same answer — the precondition for an exact-cache hit.
 */
export function exactCacheKey(req: ChatCompletionRequest, scope = ""): string {
  return createHash("sha256").update(canonical(req, scope)).digest("hex");
}

/**
 * The text we embed for semantic matching. We join the conversation with role
 * tags so a user prompt and an identical assistant line don't collapse, and so
 * the surrounding context participates in similarity.
 */
export function promptText(req: ChatCompletionRequest): string {
  return req.messages.map((m) => `${m.role}: ${messageText(m).trim()}`).join("\n");
}

/**
 * A coarse bucket key so semantic lookups only compare requests that share the
 * same model and answer-affecting parameters (it would be wrong to serve a
 * temperature-0 answer to a temperature-1.5 request, or cross models). The
 * embedding handles *prompt* similarity; this guards everything else.
 */
export function semanticBucket(req: ChatCompletionRequest, scope = ""): string {
  const params: Record<string, unknown> = {};
  for (const key of ANSWER_AFFECTING_KEYS) {
    const val = (req as Record<string, unknown>)[key];
    if (val !== undefined) params[key] = val;
  }
  return createHash("sha256")
    .update(stableStringify({ model: req.model, params, ...(scope ? { scope } : {}) }))
    .digest("hex")
    .slice(0, 16);
}
