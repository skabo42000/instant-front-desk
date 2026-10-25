import "server-only";
import { createChatHandler } from "./chat-handler";
import { ChatRateLimiter } from "./chat-limits";
import { createRateLimitStore, type RateLimitStore } from "./rate-limit-store";
import { getLocalDatabase } from "./local-businesses";
import { getChatServices } from "./chat-runtime";
import { getBusinessData } from "./business-data";
import { jsonTelemetry } from "./telemetry";

// Browser and MCP calls share these existing process-wide counters and runtime.
const local = globalThis as typeof globalThis & { frontDeskLimiter?: ChatRateLimiter; frontDeskRateStore?: RateLimitStore };
export function handleChatRequest(request: Request): Promise<Response> {
  return createChatHandler(getLocalDatabase,
    local.frontDeskLimiter ??= new ChatRateLimiter(10, 60, 60000, { consume: (...args) =>
      (local.frontDeskRateStore ??= createRateLimitStore()).consume(...args) }), undefined, getChatServices,
    { data: getBusinessData, telemetry: jsonTelemetry })(request);
}
