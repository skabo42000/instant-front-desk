import "server-only";
export const MAX_QUESTION_LENGTH = 2000;
export const MAX_BODY_BYTES = 12000;
export const MAX_ANSWER_LENGTH = 4000;

export class ChatRateLimiter {
  private buckets = new Map<string, { count: number; expires: number }>();
  constructor(private clientLimit = 10, private businessLimit = 60, private windowMs = 60000) {}
  take(businessId: string, clientId: string, now = Date.now()): boolean {
    for (const [key, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(key);
    const keys = [`business:${businessId}`, `client:${clientId}`];
    const limits = [this.businessLimit, this.clientLimit];
    if (keys.some((key, i) => (this.buckets.get(key)?.count ?? 0) >= limits[i])) return false;
    // Bound memory when callers keep changing their browser identity.
    if (this.buckets.size + keys.filter(key => !this.buckets.has(key)).length > 10000) return false;
    for (const key of keys) {
      const bucket = this.buckets.get(key) ?? { count: 0, expires: now + this.windowMs };
      bucket.count += 1;
      this.buckets.set(key, bucket);
    }
    return true;
  }
}
