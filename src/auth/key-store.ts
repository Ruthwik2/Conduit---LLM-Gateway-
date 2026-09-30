import type Redis from "ioredis";
import { AuthError } from "../util/errors.js";
import {
  buildKeyFromSecret,
  hashSecret,
  mintKey,
  type CreateKeyInput,
  type VirtualKey,
} from "./virtual-key.js";

/**
 * Persists virtual keys. Lookups happen on every request, so the hot path
 * (`findBySecret`) is a single hashed-key fetch. Only hashes are stored.
 */
export interface KeyStore {
  /** Resolve a presented plaintext secret to its key, or null. */
  findBySecret(secret: string): Promise<VirtualKey | null>;
  getById(id: string): Promise<VirtualKey | null>;
  list(): Promise<VirtualKey[]>;
  /** Create a brand-new key and return the one-time secret alongside it. */
  create(input: CreateKeyInput): Promise<{ key: VirtualKey; secret: string }>;
  /** Register a key built from a known secret (seed keys). Idempotent by hash. */
  registerSecret(secret: string, input: CreateKeyInput): Promise<VirtualKey>;
  revoke(id: string): Promise<boolean>;
}

export class MemoryKeyStore implements KeyStore {
  private byId = new Map<string, VirtualKey>();
  private idByHash = new Map<string, string>();

  async findBySecret(secret: string): Promise<VirtualKey | null> {
    const id = this.idByHash.get(hashSecret(secret));
    if (!id) return null;
    return this.byId.get(id) ?? null;
  }

  async getById(id: string): Promise<VirtualKey | null> {
    return this.byId.get(id) ?? null;
  }

  async list(): Promise<VirtualKey[]> {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async create(input: CreateKeyInput): Promise<{ key: VirtualKey; secret: string }> {
    const { key, secret } = mintKey(input);
    this.byId.set(key.id, key);
    this.idByHash.set(key.hashedKey, key.id);
    return { key, secret };
  }

  async registerSecret(secret: string, input: CreateKeyInput): Promise<VirtualKey> {
    const existingId = this.idByHash.get(hashSecret(secret));
    if (existingId) return this.byId.get(existingId)!;
    const key = buildKeyFromSecret(secret, input);
    this.byId.set(key.id, key);
    this.idByHash.set(key.hashedKey, key.id);
    return key;
  }

  async revoke(id: string): Promise<boolean> {
    const key = this.byId.get(id);
    if (!key) return false;
    this.byId.delete(id);
    this.idByHash.delete(key.hashedKey);
    return true;
  }
}

/**
 * Redis-backed key store. Two key spaces:
 *   conduit:key:rec:{id}    → JSON record
 *   conduit:key:hash:{hash} → id   (reverse index for the auth hot path)
 */
export class RedisKeyStore implements KeyStore {
  private recPrefix = "conduit:key:rec:";
  private hashPrefix = "conduit:key:hash:";

  constructor(private redis: Redis) {}

  private async readById(id: string): Promise<VirtualKey | null> {
    const raw = await this.redis.get(this.recPrefix + id);
    return raw ? (JSON.parse(raw) as VirtualKey) : null;
  }

  private async write(key: VirtualKey): Promise<void> {
    await this.redis
      .multi()
      .set(this.recPrefix + key.id, JSON.stringify(key))
      .set(this.hashPrefix + key.hashedKey, key.id)
      .exec();
  }

  async findBySecret(secret: string): Promise<VirtualKey | null> {
    const id = await this.redis.get(this.hashPrefix + hashSecret(secret));
    if (!id) return null;
    return this.readById(id);
  }

  async getById(id: string): Promise<VirtualKey | null> {
    return this.readById(id);
  }

  async list(): Promise<VirtualKey[]> {
    const out: VirtualKey[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${this.recPrefix}*`,
        "COUNT",
        200,
      );
      cursor = next;
      if (keys.length) {
        const vals = await this.redis.mget(...keys);
        for (const v of vals) if (v) out.push(JSON.parse(v) as VirtualKey);
      }
    } while (cursor !== "0");
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async create(input: CreateKeyInput): Promise<{ key: VirtualKey; secret: string }> {
    const { key, secret } = mintKey(input);
    await this.write(key);
    return { key, secret };
  }

  async registerSecret(secret: string, input: CreateKeyInput): Promise<VirtualKey> {
    const existing = await this.findBySecret(secret);
    if (existing) return existing;
    const key = buildKeyFromSecret(secret, input);
    await this.write(key);
    return key;
  }

  async revoke(id: string): Promise<boolean> {
    const key = await this.readById(id);
    if (!key) return false;
    await this.redis
      .multi()
      .del(this.recPrefix + id)
      .del(this.hashPrefix + key.hashedKey)
      .exec();
    return true;
  }
}

/**
 * Resolve the Bearer secret to an active key or throw the OpenAI-shaped 401.
 * Centralized so every route authenticates identically.
 */
export async function authenticate(store: KeyStore, secret: string | undefined): Promise<VirtualKey> {
  if (!secret) {
    throw new AuthError("Missing bearer token. Pass your Conduit key as `Authorization: Bearer <key>`.");
  }
  const key = await store.findBySecret(secret);
  if (!key || key.disabled) {
    throw new AuthError("Invalid or revoked API key.");
  }
  return key;
}
