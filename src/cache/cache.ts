import type { CacheConfig } from "../config/schema.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types/openai.js";
import type { ServeOutcome } from "../types/internal.js";
import type { Embedder } from "./embeddings.js";
import type { ExactStore } from "./exact-store.js";
import type { SemanticStore } from "./semantic-store.js";
import { exactCacheKey, promptText, semanticBucket } from "./key.js";

export interface CacheLookup {
  response: ChatCompletionResponse;
  outcome: Extract<ServeOutcome, "cache_exact" | "cache_semantic">;
  /** Present only for semantic hits. */
  similarity?: number;
}

/**
 * Two-tier cache. The exact tier is a hash lookup (fast, exact). The semantic
 * tier embeds the prompt and finds a near-duplicate above a similarity
 * threshold. Exact is always tried first because it is cheaper and strictly
 * more precise.
 *
 * Eligibility rules keep the cache correct:
 *   - High-temperature requests are non-deterministic by design, so we never
 *     serve a *semantic* neighbor for them (an exact re-ask is still fine).
 *   - Tool-calling requests are skipped for semantic matching: a paraphrase
 *     could legitimately warrant different tool calls.
 *   - Multi-choice (`n > 1`) requests are not cached; our single-choice replay
 *     would misrepresent them.
 */
export class CacheService {
  constructor(
    private cfg: CacheConfig,
    private exact: ExactStore,
    private semantic: SemanticStore,
    private embedder: Embedder,
  ) {}

  private cacheable(req: ChatCompletionRequest): boolean {
    if (!this.cfg.enabled) return false;
    const n = (req as { n?: number }).n;
    if (typeof n === "number" && n > 1) return false;
    return true;
  }

  /** "" for a shared cache; the key id when the operator asked for isolation. */
  private scopeTag(keyId: string): string {
    return this.cfg.scope === "per_key" ? keyId : "";
  }

  private semanticEligible(req: ChatCompletionRequest): boolean {
    if (!this.cfg.semantic.enabled) return false;
    if (Array.isArray((req as { tools?: unknown[] }).tools) && (req as { tools: unknown[] }).tools.length > 0) {
      return false;
    }
    const temp = (req as { temperature?: number }).temperature;
    if (typeof temp === "number" && temp > this.cfg.semantic.maxTemperature) return false;
    return true;
  }

  async lookup(req: ChatCompletionRequest, keyId: string): Promise<CacheLookup | null> {
    if (!this.cacheable(req)) return null;
    const scope = this.scopeTag(keyId);

    if (this.cfg.exact.enabled) {
      const hit = await this.exact.get(exactCacheKey(req, scope));
      if (hit) return { response: hit.response, outcome: "cache_exact" };
    }

    if (this.semanticEligible(req)) {
      const vector = await this.embedder.embed(promptText(req));
      const hit = await this.semantic.query(
        semanticBucket(req, scope),
        vector,
        this.cfg.semantic.similarityThreshold,
      );
      if (hit) {
        return { response: hit.response, outcome: "cache_semantic", similarity: hit.similarity };
      }
    }

    return null;
  }

  /**
   * Persist a freshly-computed answer into both tiers it is eligible for. Called
   * after a successful upstream call (streaming answers are reassembled first).
   * Failures here are swallowed by the caller — a cache write must never break a
   * request that already succeeded.
   */
  async store(
    req: ChatCompletionRequest,
    response: ChatCompletionResponse,
    keyId: string,
  ): Promise<void> {
    if (!this.cacheable(req)) return;
    const scope = this.scopeTag(keyId);

    if (this.cfg.exact.enabled) {
      await this.exact.set(exactCacheKey(req, scope), response, this.cfg.exact.ttlSeconds);
    }

    if (this.semanticEligible(req)) {
      const vector = await this.embedder.embed(promptText(req));
      await this.semantic.add(
        semanticBucket(req, scope),
        vector,
        response,
        this.cfg.semantic.ttlSeconds,
      );
    }
  }
}
