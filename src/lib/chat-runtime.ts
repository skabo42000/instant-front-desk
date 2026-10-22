import "server-only";
import { FakeEmbeddings, type EmbeddingAdapter } from "./models/embeddings";
import { ModelGateway } from "./models/gateway";
import { embeddingBatches, evaluationProviders, GeminiEmbeddings, ProviderError, type HttpTransport } from "./models/providers";
import { PostgresProviderBudget, type ProviderBudget } from "./shared-controls";
import { createPilotRpc } from "./pilot-rpc";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalProviderStop } from "./provider-stop";

type Environment = Readonly<Record<string, string | undefined>>;
export interface ChatServices {
  mode: "fake" | "real";
  embeddings: EmbeddingAdapter;
  gateway: ModelGateway;
}
export type ChatRuntime = (embeddingModel: string) => ChatServices;

// One runtime per server process: every embedding, retry and fallback shares the cap.
// Billing is controlled by the provider account, not by an API request parameter.
export function createChatRuntime(env: Environment = process.env,
  transport: HttpTransport = (url, init) => fetch(url, init), budget?: ProviderBudget): ChatRuntime {
  const fake: ChatServices = { mode: "fake", embeddings: new FakeEmbeddings(), gateway: new ModelGateway() };
  let real: ChatServices | undefined;
  let calls = 0;
  let stopped = false;
  let pendingReservations = 0;
  let heldWebsiteCalls = 0;
  let lastStopAttempt = -Infinity;
  let stopInFlight: Promise<void> | undefined;
  const persistStop = (): Promise<void> => {
    if (!budget || stopInFlight || Date.now() - lastStopAttempt < 30_000) return stopInFlight ?? Promise.resolve();
    lastStopAttempt = Date.now();
    // Refused requests never wait for storage recovery; failures keep the latch set.
    stopInFlight = Promise.resolve().then(() => budget.stop()).catch(() => {}).finally(() => { stopInFlight = undefined; });
    return stopInFlight;
  };
  const refuseStopped = (): never => {
    void persistStop();
    throw new ProviderError("FREE_TIER_EXHAUSTED");
  };
  return embeddingModel => {
    if (embeddingModel === fake.embeddings.model) return fake;
    if (embeddingModel !== "gemini-embedding-001") throw new Error("Unsupported business embedding model.");
    if ((env.LOCAL_CHAT_MODE ?? "fake") !== "real" || env.FREE_TIER_CONFIRMED !== "yes") {
      throw new Error("Real chat requires LOCAL_CHAT_MODE=real and FREE_TIER_CONFIRMED=yes.");
    }
    if (stopped) return refuseStopped();
    if (!real) {
      const maxCalls = Number(env.LOCAL_CHAT_MAX_CALLS ?? 60);
      if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error("LOCAL_CHAT_MAX_CALLS must be 1 to 300.");
      const keys = [env.GEMINI_EVAL_API_KEY, env.GROQ_EVAL_API_KEY].filter((key): key is string => !!key);
      const guarded = async (url: string, init: RequestInit, lease?: { remaining: number }): Promise<Response> => {
        if (stopped) return refuseStopped();
        if (calls >= maxCalls) throw new ProviderError("LOCAL_CALL_LIMIT");
        if (init.signal?.aborted) throw new ProviderError("TIMEOUT");
        // Pending slots prevent concurrent overshoot without charging failed DB calls.
        if (lease) {
          if (lease.remaining < 1) throw new ProviderError("LOCAL_CALL_LIMIT");
          lease.remaining--; heldWebsiteCalls--;
        } else if (calls + pendingReservations + heldWebsiteCalls >= maxCalls) throw new ProviderError("LOCAL_CALL_LIMIT");
        pendingReservations++;
        try {
          if (budget && !await budget.reserve(maxCalls)) {
            // An exhausted/shared-stopped budget refuses calls, but isn't a new provider quota event.
            throw new ProviderError("FREE_TIER_EXHAUSTED");
          }
          calls++;
        } finally { pendingReservations--; }
        if (stopped) return refuseStopped();
        const response = await transport(url, { ...init, redirect: "error" });
        if (response.status === 429) {
          stopped = true;
          await persistStop();
          throw new ProviderError("FREE_TIER_EXHAUSTED");
        }
        const raw = await response.text();
        let decoded: unknown;
        try { decoded = JSON.parse(raw); } catch { /* The adapter rejects malformed replies. */ }
        if ((!response.ok || (decoded && typeof decoded === "object" && "error" in decoded)) &&
            /quota|resource_exhausted|rate.?limit|free.?tier/i.test(raw)) {
          stopped = true;
          await persistStop();
          throw new ProviderError("FREE_TIER_EXHAUSTED");
        }
        if (keys.some(key => raw.includes(key) || JSON.stringify(decoded)?.includes(key))) throw new ProviderError("MALFORMED");
        return new Response(raw, { status: response.status, headers: response.headers });
      };
      const providers = evaluationProviders(env, guarded, 15000);
      const embeddings: EmbeddingAdapter = {
        model: providers.embeddings.model, dimensions: providers.embeddings.dimensions,
        embed: input => providers.embeddings.embed(input),
        async embedMany(inputs) {
          const needed = embeddingBatches(inputs, this.model, this.dimensions).length;
          if (stopped) return refuseStopped();
          // Hold the complete load's slots synchronously, before its first provider/budget call.
          if (needed > maxCalls - calls - pendingReservations - heldWebsiteCalls) throw new ProviderError("LOCAL_CALL_LIMIT");
          const lease = { remaining: needed };
          heldWebsiteCalls += needed;
          try {
            return await new GeminiEmbeddings(env.GEMINI_EVAL_API_KEY ?? "", (url, init) => guarded(url, init, lease),
              this.model, 15000).embedMany(inputs);
          } finally { heldWebsiteCalls -= lease.remaining; }
        },
      };
      real = { mode: "real", embeddings, gateway: new ModelGateway({
        primary: { provider: "gemini", model: providers.answer.model, family: providers.answer.family, adapter: providers.answer },
        fallback: { provider: "groq", model: providers.fallback.model, family: providers.fallback.family, adapter: providers.fallback },
        attemptTimeoutMs: 16000, totalTimeoutMs: 45000,
      }) };
    }
    return real;
  };
}

const local = globalThis as typeof globalThis & { frontDeskChatRuntime?: ChatRuntime };
export function getChatServices(embeddingModel: string): ChatServices {
  return (local.frontDeskChatRuntime ??= createChatRuntime(process.env, undefined,
    process.env.IFD_PILOT_MODE === "yes" ? new PostgresProviderBudget(createPilotRpc(process.env), new LocalProviderStop(process.env.IFD_PROVIDER_STOP_DIR ?? (process.env.IFD_DATA_STORE === "postgres" ? join(homedir(), "ifd-postgres/provider-stop") : undefined))) : undefined))(embeddingModel);
}
