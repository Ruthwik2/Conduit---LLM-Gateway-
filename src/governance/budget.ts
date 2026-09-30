import type Redis from "ioredis";
import { BudgetExceededError } from "../util/errors.js";
import type { VirtualKey } from "../auth/virtual-key.js";

/**
 * Tracks cumulative spend per virtual key. Spend is recorded *after* each call
 * (once real token usage is known) and the cap is enforced *before* the next
 * call. This means a key can overshoot its cap by at most the cost of the single
 * in-flight request that crossed the line — the standard, sane behavior for
 * post-paid metering.
 */
export interface BudgetStore {
  getSpend(keyId: string): Promise<number>;
  /** Atomically add cost and return the new running total. */
  addSpend(keyId: string, costUsd: number): Promise<number>;
  reset(keyId: string): Promise<void>;
}

export class MemoryBudgetStore implements BudgetStore {
  private spend = new Map<string, number>();

  async getSpend(keyId: string): Promise<number> {
    return this.spend.get(keyId) ?? 0;
  }

  async addSpend(keyId: string, costUsd: number): Promise<number> {
    const next = (this.spend.get(keyId) ?? 0) + costUsd;
    this.spend.set(keyId, next);
    return next;
  }

  async reset(keyId: string): Promise<void> {
    this.spend.delete(keyId);
  }
}

export class RedisBudgetStore implements BudgetStore {
  private prefix = "conduit:budget:";

  constructor(private redis: Redis) {}

  async getSpend(keyId: string): Promise<number> {
    const raw = await this.redis.get(this.prefix + keyId);
    return raw ? Number(raw) : 0;
  }

  async addSpend(keyId: string, costUsd: number): Promise<number> {
    // INCRBYFLOAT is atomic and returns the post-increment value.
    const next = await this.redis.incrbyfloat(this.prefix + keyId, costUsd);
    return Number(next);
  }

  async reset(keyId: string): Promise<void> {
    await this.redis.del(this.prefix + keyId);
  }
}

/**
 * Pre-call budget gate. Throws the OpenAI-shaped 402 when the key's recorded
 * spend has already reached its cap. Keys with a null cap are unlimited.
 */
export async function enforceBudget(store: BudgetStore, key: VirtualKey): Promise<number> {
  const spent = await store.getSpend(key.id);
  if (key.budgetUsd !== null && spent >= key.budgetUsd) {
    throw new BudgetExceededError(spent, key.budgetUsd);
  }
  return spent;
}
