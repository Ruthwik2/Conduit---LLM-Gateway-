import type { Pool } from "pg";
import type { ChatCompletionResponse } from "../types/openai.js";

export interface SemanticHit {
  response: ChatCompletionResponse;
  similarity: number;
}

export interface SemanticStore {
  /** Create tables/indexes if needed. No-op for in-memory. */
  init(): Promise<void>;
  /** Release timers/resources held by the store (not the DB connection). */
  dispose?(): void;
  /**
   * Return the single best match in `bucket` whose cosine similarity to
   * `embedding` is >= `threshold`, or null.
   */
  query(
    bucket: string,
    embedding: number[],
    threshold: number,
  ): Promise<SemanticHit | null>;
  add(
    bucket: string,
    embedding: number[],
    response: ChatCompletionResponse,
    ttlSeconds: number,
  ): Promise<void>;
  clear(): Promise<void>;
}

/** Dot product of two equal-length vectors (== cosine for unit vectors). */
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

interface MemRow {
  embedding: number[];
  response: ChatCompletionResponse;
  expiresAt: number;
}

/**
 * In-memory semantic store: a brute-force nearest-neighbor scan within each
 * bucket. O(n) per query, which is perfectly adequate for local/demo/test
 * volumes. pgvector is the path for large corpora.
 */
export class MemorySemanticStore implements SemanticStore {
  private buckets = new Map<string, MemRow[]>();

  constructor(private now: () => number = Date.now) {}

  async init(): Promise<void> {
    /* nothing to set up */
  }

  async query(
    bucket: string,
    embedding: number[],
    threshold: number,
  ): Promise<SemanticHit | null> {
    const rows = this.buckets.get(bucket);
    if (!rows || rows.length === 0) return null;
    const now = this.now();

    let best: SemanticHit | null = null;
    const live: MemRow[] = [];
    for (const row of rows) {
      if (row.expiresAt <= now) continue; // expired → drop on this pass
      live.push(row);
      const sim = dot(embedding, row.embedding);
      if (sim >= threshold && (!best || sim > best.similarity)) {
        best = { response: row.response, similarity: sim };
      }
    }
    if (live.length !== rows.length) this.buckets.set(bucket, live);
    return best;
  }

  async add(
    bucket: string,
    embedding: number[],
    response: ChatCompletionResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const now = this.now();
    // Drop expired rows on write too, so write-heavy buckets that are rarely
    // queried can't grow without bound.
    const rows = (this.buckets.get(bucket) ?? []).filter((r) => r.expiresAt > now);
    rows.push({ embedding, response, expiresAt: now + ttlSeconds * 1000 });
    this.buckets.set(bucket, rows);
  }

  async clear(): Promise<void> {
    this.buckets.clear();
  }
}

/** Serialize a JS number[] into pgvector's text input format: `[a,b,c]`. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * pgvector-backed semantic store. Uses the cosine distance operator `<=>` and a
 * partial index to find nearest neighbors. Similarity is `1 - distance`.
 *
 * Rows carry an `expires_at`; the query filters on it, and a periodic prune (or
 * a scheduled job) can reclaim space. We keep the schema minimal and let the
 * vector index do the heavy lifting.
 */
/** How often expired semantic-cache rows are deleted (see prune()). */
const PRUNE_INTERVAL_MS = 5 * 60_000;

export class PgVectorSemanticStore implements SemanticStore {
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private pool: Pool,
    private dimensions: number,
    private table = "conduit_semantic_cache",
  ) {}

  async init(): Promise<void> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id          BIGSERIAL PRIMARY KEY,
         bucket      TEXT NOT NULL,
         embedding   vector(${this.dimensions}) NOT NULL,
         response    JSONB NOT NULL,
         expires_at  TIMESTAMPTZ NOT NULL,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    // IVFFlat index for cosine distance. `lists` is a reasonable default for
    // modest corpora; tune upward with data volume.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
         ON ${this.table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_bucket_idx ON ${this.table} (bucket)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_expires_idx ON ${this.table} (expires_at)`,
    );

    // Queries already filter on expires_at, but without deletion the table (and
    // the vector index) would grow forever. Prune on boot, then periodically on
    // an unref'd timer so it never keeps the process alive. Failures are
    // non-fatal: a missed prune only delays space reclamation.
    await this.prune().catch(() => undefined);
    this.pruneTimer = setInterval(() => {
      void this.prune().catch(() => undefined);
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  /** Delete expired rows; returns how many were reclaimed. */
  async prune(): Promise<number> {
    const res = await this.pool.query(`DELETE FROM ${this.table} WHERE expires_at <= now()`);
    return res.rowCount ?? 0;
  }

  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  async query(
    bucket: string,
    embedding: number[],
    threshold: number,
  ): Promise<SemanticHit | null> {
    const vec = toVectorLiteral(embedding);
    const res = await this.pool.query<{ response: ChatCompletionResponse; similarity: number }>(
      `SELECT response, 1 - (embedding <=> $1::vector) AS similarity
         FROM ${this.table}
        WHERE bucket = $2 AND expires_at > now()
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [vec, bucket],
    );
    const row = res.rows[0];
    if (!row) return null;
    const similarity = Number(row.similarity);
    if (similarity < threshold) return null;
    return { response: row.response, similarity };
  }

  async add(
    bucket: string,
    embedding: number[],
    response: ChatCompletionResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const vec = toVectorLiteral(embedding);
    await this.pool.query(
      `INSERT INTO ${this.table} (bucket, embedding, response, expires_at)
       VALUES ($1, $2::vector, $3::jsonb, now() + ($4 || ' seconds')::interval)`,
      [bucket, vec, JSON.stringify(response), String(ttlSeconds)],
    );
  }

  async clear(): Promise<void> {
    await this.pool.query(`TRUNCATE ${this.table}`);
  }
}
