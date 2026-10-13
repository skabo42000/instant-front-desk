import "server-only";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { answer } from "./answer";
import { retrieve } from "./retrieve";
import { businessRepository } from "./db/repository";
import { findBusiness } from "./local-businesses";
import { ModelGateway } from "./models/gateway";
import { ChatRateLimiter, MAX_ANSWER_LENGTH, MAX_BODY_BYTES, MAX_QUESTION_LENGTH } from "./chat-limits";

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("empty");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("large"); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
export function createChatHandler(getDatabase: () => Promise<PGlite>, limiter: ChatRateLimiter,
  gateway: () => ModelGateway = () => new ModelGateway()) {
  return async (request: Request): Promise<Response> => {
    const match = request.headers.get("cookie")?.match(/(?:^|;\s*)ifd-client=([0-9a-f-]{36})(?:;|$)/i);
    const clientId = match?.[1] ?? randomUUID();
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: {
      "Cache-Control": "no-store",
      ...(!match ? { "Set-Cookie": `ifd-client=${clientId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` } : {}),
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    } });
    let input: unknown;
    try { input = await readBody(request); } catch { return reply({ error: "Please send a shorter question in the expected format." }, 400); }
    if (!input || typeof input !== "object" || !("slug" in input) || !("question" in input) ||
      typeof input.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(input.slug) ||
      typeof input.question !== "string" || !input.question.trim() || input.question.length > MAX_QUESTION_LENGTH) {
      return reply({ error: `Please enter a question of 1 to ${MAX_QUESTION_LENGTH} characters.` }, 400);
    }
    try {
      const db = await getDatabase();
      const business = await findBusiness(db, input.slug);
      if (!business) return reply({ error: "That business was not found." }, 404);
      if (!(await limiter.take(business.businessId, clientId))) return reply({ error: "Please wait a minute before asking again." }, 429);
      const sources = await retrieve(input.question.trim(), businessRepository(db, business.businessId));
      const result = await answer(input.question.trim(), sources.chunks, gateway(), sources.contactChunks);
      // Logs and provider settings never leave the server.
      if (result.text.length > MAX_ANSWER_LENGTH || result.citations.length > 5 ||
        result.citations.some(citation => citation.pageUrl.length > 2048 || citation.heading.length > 200)) {
        return reply({ kind: "refusal", text: "I couldn't find a short, supported answer on this website.", citations: [] });
      }
      return reply({ kind: result.kind, text: result.text, citations: result.citations });
    } catch { return reply({ error: "The assistant is unavailable. Please try again later." }, 503); }
  };
}
