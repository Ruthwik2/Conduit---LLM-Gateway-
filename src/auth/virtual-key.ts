import { createHash } from "node:crypto";
import { generateVirtualKey } from "../util/id.js";

/**
 * A Conduit-issued credential. The plaintext secret is shown exactly once, at
 * creation; only its SHA-256 hash is ever persisted, so a leaked store cannot
 * be used to call the gateway. `id` is independent of the secret, so it is safe
 * to log and to use in admin APIs.
 */
export interface VirtualKey {
  id: string;
  name: string;
  /** SHA-256 (hex) of the plaintext secret. Lookups hash the presented key. */
  hashedKey: string;
  /** First few chars of the secret, for display only (e.g. "ck-ab12…"). */
  display: string;
  /** Spend cap in USD; null means unlimited. */
  budgetUsd: number | null;
  rateLimit: { requestsPerMinute: number; burst: number };
  /** Allowed model ids; null means all models are permitted. */
  allowedModels: string[] | null;
  createdAt: number;
  disabled: boolean;
}

export interface CreateKeyInput {
  name: string;
  budgetUsd?: number | null;
  rateLimit?: { requestsPerMinute: number; burst?: number };
  allowedModels?: string[] | null;
}

/** SHA-256 of a plaintext secret, hex-encoded. */
export function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function displayFor(secret: string): string {
  return `${secret.slice(0, 6)}…${secret.slice(-2)}`;
}

/** Default burst = one minute's worth of requests unless the caller overrides. */
function normalizeRate(rl?: { requestsPerMinute: number; burst?: number }): {
  requestsPerMinute: number;
  burst: number;
} {
  const rpm = rl?.requestsPerMinute ?? 60;
  return { requestsPerMinute: rpm, burst: rl?.burst ?? rpm };
}

/** Build a key record around a freshly generated secret. Returns both. */
export function mintKey(input: CreateKeyInput): { key: VirtualKey; secret: string } {
  const secret = generateVirtualKey();
  return { key: buildKeyFromSecret(secret, input), secret };
}

/** Build a key record around a *known* secret (used for seed keys from config). */
export function buildKeyFromSecret(secret: string, input: CreateKeyInput): VirtualKey {
  return {
    id: `vk_${hashSecret(secret).slice(0, 24)}`,
    name: input.name,
    hashedKey: hashSecret(secret),
    display: displayFor(secret),
    budgetUsd: input.budgetUsd ?? null,
    rateLimit: normalizeRate(input.rateLimit),
    allowedModels: input.allowedModels ?? null,
    createdAt: Date.now(),
    disabled: false,
  };
}

/** Whether this key is permitted to use the given model. */
export function keyAllowsModel(key: VirtualKey, model: string): boolean {
  return key.allowedModels === null || key.allowedModels.includes(model);
}
