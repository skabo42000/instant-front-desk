import "server-only";
import { chatRequestOriginAllowed } from "./request-origin";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { answer, prepareAnswerEvidence, ANSWER_PROMPT_VERSION } from "./answer";
import { retrieve } from "./retrieve";
import { ModelGateway } from "./models/gateway";
import { createChatRuntime, type ChatRuntime } from "./chat-runtime";
import { ChatRateLimiter, MAX_ANSWER_LENGTH, MAX_BODY_BYTES, MAX_QUESTION_LENGTH } from "./chat-limits";
import { localBusinessData, type BusinessData } from "./business-data";
import { usageSummary, type ChatEvent, type FailureReason, type TelemetrySink } from "./telemetry";

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
  gateway?: () => ModelGateway, runtime: ChatRuntime = createChatRuntime({}),
  options: { telemetry?: TelemetrySink; data?: BusinessData | (() => BusinessData) } = {}) {
  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    const event: ChatEvent = { schema: 1, event: "chat.request", requestId: randomUUID(), at: new Date().toISOString(),
      businessId: null, status: 503, outcome: "error", failureReason: null, refusalReason: null, totalMs: 0,
      retrievalMs: null, answerMs: null, retrievedCount: 0, effectiveCount: 0, ...usageSummary([]), answerPromptVersion: ANSWER_PROMPT_VERSION };
    const match = request.headers.get("cookie")?.match(/(?:^|;\s*)ifd-client=([0-9a-f-]{36})(?:;|$)/i);
    const clientId = match?.[1] ?? randomUUID();
    const reply = (body: unknown, status = 200, reason: FailureReason = null) => {
      event.status = status; event.failureReason = reason; event.totalMs = Math.round(performance.now() - started);
      try { options.telemetry?.(structuredClone(event)); } catch { /* Logging failure cannot break a visitor request. */ }
      return Response.json(body, { status, headers: {
      "Cache-Control": "no-store",
      "X-Request-ID": event.requestId,
      "X-Content-Type-Options": "nosniff",
      ...(!match ? { "Set-Cookie": `ifd-client=${clientId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` } : {}),
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    } }); };
    if (!chatRequestOriginAllowed(request)) return reply({ error: "Request origin is not allowed." }, 403, "cross-origin");
    let input: unknown;
    try { input = await readBody(request); } catch { return reply({ error: "Please send a shorter question in the expected format." }, 400, "invalid-request"); }
    if (!input || typeof input !== "object" || !("slug" in input) || !("question" in input) ||
      typeof input.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(input.slug) ||
      typeof input.question !== "string" || !input.question.trim() || input.question.length > MAX_QUESTION_LENGTH) {
      return reply({ error: `Please enter a question of 1 to ${MAX_QUESTION_LENGTH} characters.` }, 400, "invalid-request");
    }
    try {
      const data = (typeof options.data === "function" ? options.data() : options.data) ?? localBusinessData(getDatabase);
      const business = await data.find(input.slug);
      if (!business) return reply({ error: "That business was not found." }, 404, "business-not-found");
      event.businessId = business.businessId;
      try {
        if (!(await limiter.take(business.businessId, clientId))) return reply({ error: "Please wait a minute before asking again." }, 429, "rate-limit");
      } catch { return reply({ error: "The assistant is unavailable. Please try again later." }, 503, "rate-store-unavailable"); }
      const services = runtime(business.embeddingModel);
      event.failureReason = "retrieval-error";
      const retrievalStart = performance.now();
      const sources = await retrieve(input.question.trim(), data.repository(business.businessId), { adapter: services.embeddings });
      event.retrievalMs = Math.round(performance.now() - retrievalStart); event.retrievedCount = sources.chunks.length;
      event.effectiveCount = prepareAnswerEvidence(input.question.trim(), sources.chunks).length;
      const answerStart = performance.now(); event.failureReason = "model-error";
      const result = await answer(input.question.trim(), sources.chunks, gateway?.() ?? services.gateway, sources.contactChunks);
      event.answerMs = Math.round(performance.now() - answerStart); event.refusalReason = result.refusalReason ?? null;
      Object.assign(event, usageSummary(result.logs));
      if (services.mode === "real" && result.refusalReason === "model-error") {
        return reply({ error: "The assistant is unavailable. Please try again later." }, 503,
          result.logs.some(l => l.errorCode === "FREE_TIER_EXHAUSTED") ? "quota-stop" : "model-error");
      }
      // Logs and provider settings never leave the server.
      if (result.text.length > MAX_ANSWER_LENGTH || result.citations.length > 8 ||
        result.citations.some(citation => citation.pageUrl.length > 2048 || citation.heading.length > 200)) {
        event.outcome = "refusal";
        return reply({ kind: "refusal", text: "I couldn't find a short, supported answer on this website.", citations: [] }, 200, "output-limit");
      }
      event.outcome = result.kind;
      return reply({ kind: result.kind, text: result.text, citations: result.citations });
    } catch (error) {
      return reply({ error: "The assistant is unavailable. Please try again later." }, 503,
        error instanceof Error && error.name === "FreeTierExhausted" ? "quota-stop" : event.failureReason ?? "unavailable");
    }
  };
}
