import "server-only";
import type { ClientConfig } from "./types";

type Environment = Readonly<Record<string, string | undefined>>;

export type ServerConfig =
  | { mode: "fake" }
  | {
      mode: "real";
      databaseUrl: string;
      geminiApiKey: string;
      geminiEvalApiKey: string;
      groqApiKey: string;
    };

export function getServerConfig(env: Environment = process.env): ServerConfig {
  const mode = env.MODEL_MODE?.trim() || "fake";
  if (mode === "fake") return { mode: "fake" };
  if (mode !== "real") {
    throw new Error("MODEL_MODE must be fake or real.");
  }

  const required = ["DATABASE_URL", "GEMINI_API_KEY", "GEMINI_EVAL_API_KEY", "GROQ_API_KEY"] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Real mode requires: ${missing.join(", ")}. Use MODEL_MODE=fake for offline work.`);
  }
  const databaseUrl = env.DATABASE_URL!.trim();
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    throw new Error("DATABASE_URL must be a valid Postgres URL.");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (env.GEMINI_API_KEY!.trim() === env.GEMINI_EVAL_API_KEY!.trim()) {
    throw new Error("GEMINI_EVAL_API_KEY must be separate from GEMINI_API_KEY.");
  }
  return {
    mode: "real",
    databaseUrl,
    geminiApiKey: env.GEMINI_API_KEY!.trim(),
    geminiEvalApiKey: env.GEMINI_EVAL_API_KEY!.trim(),
    groqApiKey: env.GROQ_API_KEY!.trim(),
  };
}

export function getClientConfig(config: ServerConfig): ClientConfig {
  return { mode: config.mode };
}
