import "server-only";
import { FakeModel } from "./fake";
import type { ModelAdapter, ModelReply, ModelRequest } from "../types";

export interface AnswerProvider {
  provider: string;
  model: string;
  family: string;
  adapter: ModelAdapter;
}

// Judge settings are deliberately not part of answer routing.
export interface JudgeConfig { provider: string; model: string; family: string }
export function assertIndependentJudge(answerFamily: string, judge: JudgeConfig): void {
  if (answerFamily.trim().toLowerCase() === judge.family.trim().toLowerCase()) {
    throw new Error("Judge must use a different model family from this answer.");
  }
}

export interface RequestLog {
  provider: string;
  model: string;
  attempt: number;
  status: "success" | "error" | "timeout";
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: null;
}
export interface GatewayOptions {
  primary?: AnswerProvider;
  fallback?: AnswerProvider;
  totalTimeoutMs?: number;
  attemptTimeoutMs?: number;
  retry?: boolean;
  onLog?: (log: RequestLog) => void;
}
export type GatewayResult =
  | { ok: true; reply: ModelReply; family: string; logs: RequestLog[] }
  | { ok: false; logs: RequestLog[] };

export class ModelGateway {
  private readonly primary: AnswerProvider;
  constructor(private readonly options: GatewayOptions = {}) {
    this.primary = options.primary ?? {
      provider: "fake", model: "scripted", family: "fake", adapter: new FakeModel([]),
    };
    for (const value of [options.totalTimeoutMs ?? 5000, options.attemptTimeoutMs ?? 1500]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Timeouts must be positive.");
    }
    if (options.fallback?.provider === this.primary.provider) {
      throw new Error("Fallback must use another provider.");
    }
  }

  async generate(request: ModelRequest): Promise<GatewayResult> {
    const logs: RequestLog[] = [];
    const deadline = Date.now() + (this.options.totalTimeoutMs ?? 5000);
    const routes = [this.primary];
    if (this.options.retry !== false) routes.push(this.primary);
    if (this.options.fallback) routes.push(this.options.fallback);
    for (const route of routes) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const started = Date.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let status: RequestLog["status"] = "error";
      let reply: ModelReply | undefined;
      try {
        reply = await Promise.race([
          Promise.resolve().then(() => route.adapter.generate(structuredClone(request), { signal: controller.signal })),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              status = "timeout";
              controller.abort();
              reject(new Error("Model timeout"));
            }, Math.min(remaining, this.options.attemptTimeoutMs ?? 1500));
          }),
        ]);
        status = "success";
      } catch {
        // Do not log provider errors: they can contain request data or credentials.
      } finally {
        clearTimeout(timer);
      }
      const tokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
      const log: RequestLog = {
        provider: route.provider, model: route.model, attempt: logs.length + 1,
        status, latencyMs: Date.now() - started,
        inputTokens: tokens(reply?.usage?.inputTokens), outputTokens: tokens(reply?.usage?.outputTokens),
        estimatedCost: null,
      };
      logs.push(log);
      this.options.onLog?.({ ...log });
      if (status === "success" && reply) return { ok: true, reply, family: route.family, logs };
    }
    return { ok: false, logs };
  }
}
