import type { RouterConfig } from "../config/schema.js";

/**
 * Exponential backoff with optional full jitter.
 *
 * Full jitter (random in [0, exp]) is preferred over plain exponential because
 * it de-correlates retries across many concurrent callers, avoiding the
 * thundering-herd that hammers a recovering provider in lockstep.
 */
export function computeBackoffMs(attempt: number, cfg: RouterConfig["backoff"]): number {
  const exp = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  return cfg.jitter ? Math.random() * exp : exp;
}

/** Promise-based sleep that rejects if the abort signal fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
