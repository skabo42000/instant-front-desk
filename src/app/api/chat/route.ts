import { createChatHandler } from "@/lib/chat-handler";
import { ChatRateLimiter } from "@/lib/chat-limits";
import { createRateLimitStore } from "@/lib/rate-limit-store";
import { getLocalDatabase } from "@/lib/local-businesses";
export const runtime = "nodejs";
const local = globalThis as typeof globalThis & { frontDeskLimiter?: ChatRateLimiter };
export const POST = createChatHandler(getLocalDatabase, local.frontDeskLimiter ??= new ChatRateLimiter(10, 60, 60000, createRateLimitStore()));
