import { createChatHandler } from "@/lib/chat-handler";
import { ChatRateLimiter } from "@/lib/chat-limits";
import { getLocalDatabase } from "@/lib/local-businesses";
export const runtime = "nodejs";
const local = globalThis as typeof globalThis & { frontDeskLimiter?: ChatRateLimiter };
export const POST = createChatHandler(getLocalDatabase, local.frontDeskLimiter ??= new ChatRateLimiter());
