import "server-only";
import { FakeEmbeddings, type EmbeddingAdapter } from "./models/embeddings";
import { ModelGateway } from "./models/gateway";
import { evaluationProviders, ProviderError, type HttpTransport } from "./models/providers";
import { createSupabaseRpc, PostgresProviderBudget, type ProviderBudget } from "./shared-controls";
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
  return embeddingModel => {
    if (embeddingModel === fake.embeddings.model) return fake;
    if (embeddingModel !== "gemini-embedding-001") throw new Error("Unsupported business embedding model.");
    if ((env.LOCAL_CHAT_MODE ?? "fake") !== "real" || env.FREE_TIER_CONFIRMED !== "yes") {
      throw new Error("Real chat requires LOCAL_CHAT_MODE=real and FREE_TIER_CONFIRMED=yes.");
    }
    if (stopped) throw new ProviderError("FREE_TIER_EXHAUSTED");
    if (!real) {
      const maxCalls = Number(env.LOCAL_CHAT_MAX_CALLS ?? 60);
      if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300) throw new Error("LOCAL_CHAT_MAX_CALLS must be 1 to 300.");
      const keys = [env.GEMINI_EVAL_API_KEY, env.GROQ_EVAL_API_KEY].filter((key): key is string => !!key);
      const guarded: HttpTransport = async (url, init) => {
        if (stopped || calls >= maxCalls) {
          stopped = true;
          throw new ProviderError("FREE_TIER_EXHAUSTED");
        }
        if (init.signal?.aborted) throw new ProviderError("TIMEOUT");
        // Reserve synchronously so simultaneous requests cannot exceed this process's cap.
        calls++;
        if (budget && !await budget.reserve(maxCalls)) {
          stopped = true;
          throw new ProviderError("FREE_TIER_EXHAUSTED");
        }
        const response = await transport(url, { ...init, redirect: "error" });
        if (response.status === 429) {
          stopped = true;
          try { await budget?.stop(); } catch { /* Budget retains its local stop; this runtime also stays stopped. */ }
          throw new ProviderError("FREE_TIER_EXHAUSTED");
        }
        const raw = await response.text();
        let decoded: unknown;
        try { decoded = JSON.parse(raw); } catch { /* The adapter rejects malformed replies. */ }
        if ((!response.ok || (decoded && typeof decoded === "object" && "error" in decoded)) &&
            /quota|resource_exhausted|rate.?limit|free.?tier/i.test(raw)) {
          stopped = true;
          try { await budget?.stop(); } catch { /* Do not expose storage errors or continue this process. */ }
          throw new ProviderError("FREE_TIER_EXHAUSTED");
        }
        if (keys.some(key => raw.includes(key) || JSON.stringify(decoded)?.includes(key))) throw new ProviderError("MALFORMED");
        return new Response(raw, { status: response.status, headers: response.headers });
      };
      const providers = evaluationProviders(env, guarded, 15000);
      real = { mode: "real", embeddings: providers.embeddings, gateway: new ModelGateway({
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
    process.env.IFD_PILOT_MODE === "yes" ? new PostgresProviderBudget(createSupabaseRpc(process.env), new LocalProviderStop()) : undefined))(embeddingModel);
}
