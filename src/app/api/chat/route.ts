import { createChatHandler } from "@/lib/chat-handler";
import { ChatRateLimiter } from "@/lib/chat-limits";
import { createRateLimitStore } from "@/lib/rate-limit-store";
import { getLocalDatabase } from "@/lib/local-businesses";
import { getChatServices } from "@/lib/chat-runtime";
import { getBusinessData } from "@/lib/business-data";
import { jsonTelemetry } from "@/lib/telemetry";
import type { RateLimitStore } from "@/lib/rate-limit-store";
export const runtime = "nodejs";
const local = globalThis as typeof globalThis & { frontDeskLimiter?: ChatRateLimiter; frontDeskRateStore?: RateLimitStore };
export function POST(request: Request): Promise<Response> {
  return createChatHandler(getLocalDatabase,
    local.frontDeskLimiter ??= new ChatRateLimiter(10, 60, 60000, { consume: (...args) =>
      (local.frontDeskRateStore ??= createRateLimitStore()).consume(...args) }), undefined, getChatServices,
    { data: getBusinessData, telemetry: jsonTelemetry })(request);
}
