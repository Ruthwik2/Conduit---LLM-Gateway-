import OpenAI from "openai";
import type { EmbeddingsConfig } from "../config/schema.js";

/**
 * Produces a fixed-length, L2-normalized vector for a piece of text. Because
 * every vector is unit length, cosine similarity reduces to a dot product,
 * which is what the semantic stores rely on.
 */
export interface Embedder {
  readonly dimensions: number;
  readonly id: string;
  embed(text: string): Promise<number[]>;
}

/** Split text into lowercase word tokens for the hashing embedder. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Deterministic 32-bit FNV-1a hash of a string. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A fully local, network-free embedder built on the hashing trick (a.k.a.
 * feature hashing). Each token is hashed to a bucket and a sign, contributions
 * are summed, and the vector is L2-normalized.
 *
 * What this buys us: identical prompts collapse to cosine 1.0, and prompts that
 * share most of their words (the dominant shape of "near-duplicate" LLM traffic
 * — re-asks, light edits, reordering) land at high cosine similarity, so the
 * semantic cache is demonstrable with zero external dependencies and in tests.
 *
 * What it does NOT do: capture true synonymy ("car" vs "automobile"). For that,
 * switch `embeddings.backend` to "openai". The interface is identical, so no
 * other code changes.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;

  constructor(readonly dimensions = 256) {
    this.id = `hash-${dimensions}`;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.dimensions);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const bucket = h % this.dimensions;
      // A second hash bit decides the sign, reducing collision cancellation bias.
      const sign = (fnv1a(`${tok}#sign`) & 1) === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
    // Add a light bigram signal so word order has *some* influence.
    for (let i = 0; i + 1 < tokens.length; i++) {
      const h = fnv1a(`${tokens[i]}_${tokens[i + 1]}`);
      const bucket = h % this.dimensions;
      const sign = (fnv1a(`${tokens[i]}_${tokens[i + 1]}#s`) & 1) === 0 ? 0.5 : -0.5;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }

    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    const out = new Array<number>(this.dimensions);
    if (norm === 0) {
      out.fill(0);
      return out;
    }
    for (let i = 0; i < this.dimensions; i++) out[i] = vec[i]! / norm;
    return out;
  }
}

/** Real embeddings via OpenAI's embeddings endpoint (or any compatible server). */
export class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  readonly id: string;

  constructor(
    private model: string,
    readonly dimensions: number,
    opts: { apiKey?: string; baseURL?: string } = {},
  ) {
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "",
      baseURL: opts.baseURL,
      maxRetries: 2,
    });
    this.id = `openai-${model}-${dimensions}`;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text,
      // text-embedding-3-* support Matryoshka dimension truncation server-side.
      dimensions: this.dimensions,
    });
    const vec = res.data[0]?.embedding;
    if (!vec) throw new Error("embedding response contained no vector");
    // OpenAI vectors are already normalized, but normalize defensively so the
    // dot-product-as-cosine assumption downstream always holds.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v) => v / norm);
  }
}

export function buildEmbedder(cfg: EmbeddingsConfig): Embedder {
  if (cfg.backend === "openai") {
    return new OpenAIEmbedder(cfg.model, cfg.dimensions, {
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
    });
  }
  return new HashingEmbedder(cfg.dimensions);
}
