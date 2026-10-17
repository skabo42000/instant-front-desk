import "server-only";
import type { RequestLog } from "./models/gateway";

export const PRICE_VERSION = "public-list-usd-2026-10-15";
// Standard text list prices, verified against official pricing pages on this date.
// These estimate equivalent paid usage, NOT the bill on the owner's free accounts.
// https://ai.google.dev/gemini-api/docs/pricing
// https://console.groq.com/docs/models
const prices: Record<string, [number, number]> = {
  "gemini/gemini-3.5-flash-lite": [0.30, 2.50],
  "groq/openai/gpt-oss-120b": [0.15, 0.60],
};
export function estimateCost(provider: string, model: string, input: number | null, output: number | null): number | null {
  const rate = prices[`${provider}/${model}`];
  if (!rate || input === null || output === null || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return null;
  return (input * rate[0] + output * rate[1]) / 1_000_000;
}
export type FailureReason = "invalid-request" | "cross-origin" | "business-not-found" | "rate-limit" | "rate-store-unavailable" |
  "retrieval-error" | "model-error" | "quota-stop" | "output-limit" | "unavailable" | null;
export interface ChatEvent {
  schema: 1; event: "chat.request"; requestId: string; at: string; businessId: string | null;
  status: number; outcome: "answer" | "refusal" | "error"; failureReason: FailureReason; refusalReason: string | null;
  totalMs: number; retrievalMs: number | null; answerMs: number | null; retrievedCount: number; effectiveCount: number;
  attempts: number; inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; costIncomplete: boolean; priceVersion: string;
  answerPromptVersion: string; models: string[];
}
export type TelemetrySink = (event: ChatEvent) => void;
export function usageSummary(logs: readonly RequestLog[]) {
  const known = logs.filter(l => l.inputTokens !== null && l.outputTokens !== null);
  const costs = logs.map(l => estimateCost(l.provider, l.model, l.inputTokens, l.outputTokens));
  return { attempts: logs.length, inputTokens: known.length ? known.reduce((n,l) => n + l.inputTokens!, 0) : null,
    outputTokens: known.length ? known.reduce((n,l) => n + l.outputTokens!, 0) : null,
    estimatedCostUsd: logs.length && costs.every(c => c !== null) ? costs.reduce<number>((n,c) => n + c!, 0) : null,
    // Query embeddings and failed provider calls do not expose complete token usage here.
    costIncomplete: true, priceVersion: PRICE_VERSION,
    models: [...new Set(logs.map(l => `${l.provider}/${l.model}`))] };
}
// Construct the record explicitly at the call site. No prompt, reply, URL, cookies, IPs,
// auth headers or raw exception messages are part of this schema.
export const jsonTelemetry: TelemetrySink = event => { console.info(JSON.stringify(event)); };
export function summarizeMonitoring(events: readonly ChatEvent[]) {
  const p = (values: number[], rank: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * rank)-1)] ?? null;
  const reasons: Record<string, number> = {};
  for (const e of events) if (e.failureReason || e.refusalReason) {
    const key = e.failureReason ?? e.refusalReason!; reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return { requests: events.length, errors: events.filter(e => e.status >= 500).length,
    rateLimited: events.filter(e => e.status === 429).length, refusals: events.filter(e => e.outcome === "refusal").length,
    p50Ms: p(events.map(e => e.totalMs), .5), p95Ms: p(events.map(e => e.totalMs), .95), reasons,
    unknownCostRequests: events.filter(e => e.estimatedCostUsd === null || e.costIncomplete).length,
    knownAnswerCostSubtotalUsd: events.reduce((n,e) => n + (e.estimatedCostUsd ?? 0), 0),
    note: "Operational metadata only. No production answer-quality or completeness labels can be inferred from these counts." };
}
