import { describe, expect, it, vi } from "vitest";
import { ChatRateLimiter } from "../../src/lib/chat-limits";
import { FallbackRateLimitStore, MemoryRateLimitStore, createRateLimitStore, type RateLimitStore } from "../../src/lib/rate-limit-store";

const broken: RateLimitStore = { consume: async () => { throw new Error("database down"); } };

describe("memory rate-limit store", () => {
  it("blocks once a limit is hit and counts nothing when blocked", async () => {
    const store = new MemoryRateLimitStore();
    const entries = [{ key: "a", limit: 2 }, { key: "b", limit: 1 }];
    expect(await store.consume(entries, 100, 0)).toBe(true);
    expect(await store.consume(entries, 100, 1)).toBe(false); // b is full
    // a was not counted by the blocked call, so one hit is still left on it alone.
    expect(await store.consume([{ key: "a", limit: 2 }], 100, 2)).toBe(true);
    expect(await store.consume([{ key: "a", limit: 2 }], 100, 3)).toBe(false);
  });
  it("starts a fresh window after the time is up", async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.consume([{ key: "a", limit: 1 }], 100, 0)).toBe(true);
    expect(await store.consume([{ key: "a", limit: 1 }], 100, 99)).toBe(false);
    expect(await store.consume([{ key: "a", limit: 1 }], 100, 100)).toBe(true);
  });
  it("refuses new keys once memory is full instead of growing forever", async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 10000; i++) await store.consume([{ key: `k${i}`, limit: 1 }], 1000, 0);
    expect(await store.consume([{ key: "new", limit: 1 }], 1000, 1)).toBe(false);
    expect(await store.consume([{ key: "new", limit: 1 }], 1000, 1000)).toBe(true);
  });
});

describe("chat rate limiter with a swapped store", () => {
  it("uses the store it is given and applies client and business limits", async () => {
    const limiter = new ChatRateLimiter(1, 5, 100, new MemoryRateLimitStore());
    expect(await limiter.take("biz", "c1", 0)).toBe(true);
    expect(await limiter.take("biz", "c1", 1)).toBe(false);
    expect(await limiter.take("biz", "c2", 1)).toBe(true);
  });
});

describe("store fallback", () => {
  it("keeps limiting with the memory store when the shared store fails", async () => {
    const store = new FallbackRateLimitStore(broken);
    const entries = [{ key: "a", limit: 1 }];
    expect(await store.consume(entries, 100, 0)).toBe(true);
    expect(await store.consume(entries, 100, 1)).toBe(false);
  });
  it("uses the shared store while it works", async () => {
    const fallback = new MemoryRateLimitStore();
    const spy = vi.spyOn(fallback, "consume");
    const primary: RateLimitStore = { consume: async () => false };
    expect(await new FallbackRateLimitStore(primary, fallback).consume([{ key: "a", limit: 1 }], 100)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
  it("picks memory by default and for unknown RATE_LIMIT_STORE values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createRateLimitStore({})).toBeInstanceOf(MemoryRateLimitStore);
    expect(createRateLimitStore({ RATE_LIMIT_STORE: "memory" })).toBeInstanceOf(MemoryRateLimitStore);
    expect(warn).not.toHaveBeenCalled();
    expect(createRateLimitStore({ RATE_LIMIT_STORE: "postgres" })).toBeInstanceOf(MemoryRateLimitStore);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
