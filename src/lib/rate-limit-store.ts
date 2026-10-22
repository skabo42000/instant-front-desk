import "server-only";
import { createSupabaseRpc, PostgresRateLimitStore } from "./shared-controls";

import { createPostgresRpc } from "./postgres-rpc";

// One counter to check: a key (for example "client:abc") and how many hits the window allows.
export type RateLimitEntry = { key: string; limit: number };

// Where rate-limit counters live. Swap the implementation to change the storage
// (process memory today; a shared database later) without touching the chat code.
export interface RateLimitStore {
  // All-or-nothing: if ANY entry is already at its limit, nothing is counted and false is returned.
  // Otherwise every entry is counted once and true is returned.
  consume(entries: RateLimitEntry[], windowMs: number, now?: number): Promise<boolean>;
}

const MAX_MEMORY_KEYS = 10000;

// Local/dev store. Counters vanish on restart and are not shared between server instances.
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; expires: number }>();
  async consume(entries: RateLimitEntry[], windowMs: number, now = Date.now()): Promise<boolean> {
    for (const [key, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(key);
    if (entries.some(entry => (this.buckets.get(entry.key)?.count ?? 0) >= entry.limit)) return false;
    // Bound memory when callers keep changing their browser identity.
    if (this.buckets.size + entries.filter(entry => !this.buckets.has(entry.key)).length > MAX_MEMORY_KEYS) return false;
    for (const { key } of entries) {
      const bucket = this.buckets.get(key) ?? { count: 0, expires: now + windowMs };
      bucket.count += 1;
      this.buckets.set(key, bucket);
    }
    return true;
  }
}

// Uses the shared store, but if it throws (database down) keeps the chat working
// with the per-process memory store instead of failing every request.
export class FallbackRateLimitStore implements RateLimitStore {
  constructor(private primary: RateLimitStore, private fallback: RateLimitStore = new MemoryRateLimitStore()) {}
  async consume(entries: RateLimitEntry[], windowMs: number, now?: number): Promise<boolean> {
    try { return await this.primary.consume(entries, windowMs, now); }
    catch { return this.fallback.consume(entries, windowMs, now); }
  }
}

// A pilot must fail closed: a shared-store outage must not create a fresh memory allowance.
export function createRateLimitStore(env: Record<string, string | undefined> = process.env): RateLimitStore {
  const choice = (env.RATE_LIMIT_STORE ?? "memory").trim().toLowerCase();
  if (choice === "postgres") return new PostgresRateLimitStore(createPostgresRpc(env));
  if (choice === "supabase") return new PostgresRateLimitStore(createSupabaseRpc(env));
  if (choice !== "memory" || env.IFD_PILOT_MODE === "yes") throw new Error("A pilot requires the shared rate-limit store");
  return new MemoryRateLimitStore();
}
