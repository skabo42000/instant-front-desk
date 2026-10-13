import "server-only";
import { MemoryRateLimitStore, type RateLimitStore } from "./rate-limit-store";
export const MAX_QUESTION_LENGTH = 2000;
export const MAX_BODY_BYTES = 12000;
export const MAX_ANSWER_LENGTH = 4000;

export class ChatRateLimiter {
  constructor(private clientLimit = 10, private businessLimit = 60, private windowMs = 60000,
    private store: RateLimitStore = new MemoryRateLimitStore()) {}
  // True when the request may go ahead; counts it against both the business and the client.
  take(businessId: string, clientId: string, now = Date.now()): Promise<boolean> {
    return this.store.consume([
      { key: `business:${businessId}`, limit: this.businessLimit },
      { key: `client:${clientId}`, limit: this.clientLimit },
    ], this.windowMs, now);
  }
}
