import type { UsageRecord } from "../types/internal.js";

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cacheHits: number;
}

export interface KeyUsageSummary extends UsageTotals {
  keyId: string;
  byModel: Record<string, UsageTotals>;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, cacheHits: 0 };
}

function fold(into: UsageTotals, rec: UsageRecord): void {
  into.requests += 1;
  into.promptTokens += rec.usage.prompt_tokens;
  into.completionTokens += rec.usage.completion_tokens;
  into.costUsd += rec.costUsd;
  if (rec.outcome === "cache_exact" || rec.outcome === "cache_semantic") into.cacheHits += 1;
}

/**
 * Rolling, in-process tally of usage by key and by model. The authoritative
 * spend cap lives in the budget store; this aggregator exists to power rich
 * read-only views (the admin stats endpoint and the demo's "per-key spend"
 * panel) without querying metrics storage.
 *
 * It is intentionally process-local: in a multi-replica deployment these are
 * per-instance numbers, while Prometheus provides the cluster-wide view.
 */
export class UsageAggregator {
  private byKey = new Map<string, { totals: UsageTotals; byModel: Map<string, UsageTotals> }>();

  record(rec: UsageRecord): void {
    let bucket = this.byKey.get(rec.keyId);
    if (!bucket) {
      bucket = { totals: emptyTotals(), byModel: new Map() };
      this.byKey.set(rec.keyId, bucket);
    }
    fold(bucket.totals, rec);

    let model = bucket.byModel.get(rec.model);
    if (!model) {
      model = emptyTotals();
      bucket.byModel.set(rec.model, model);
    }
    fold(model, rec);
  }

  forKey(keyId: string): KeyUsageSummary {
    const bucket = this.byKey.get(keyId);
    const totals = bucket?.totals ?? emptyTotals();
    const byModel: Record<string, UsageTotals> = {};
    if (bucket) for (const [m, t] of bucket.byModel) byModel[m] = t;
    return { keyId, ...totals, byModel };
  }

  all(): KeyUsageSummary[] {
    return [...this.byKey.keys()].map((id) => this.forKey(id));
  }
}
