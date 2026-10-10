import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScaffoldStatus } from "@/components/ScaffoldStatus";
import { getClientConfig, getServerConfig } from "@/lib/config";

// Deliberately synthetic sentinels, never actual credentials.
const realEnvironment = {
  MODEL_MODE: "real",
  DATABASE_URL: "postgresql://fixture-user:synthetic-db-marker@localhost/fixture",
  GEMINI_API_KEY: "synthetic-answer-marker",
  GEMINI_EVAL_API_KEY: "synthetic-eval-marker",
  GROQ_API_KEY: "synthetic-judge-marker",
};

describe("server configuration", () => {
  it("defaults to fake mode without keys", () => {
    expect(getServerConfig({})).toEqual({ mode: "fake" });
    expect(getServerConfig({ MODEL_MODE: "fake" })).toEqual({ mode: "fake" });
  });

  it("discards unused credentials in fake mode", () => {
    expect(getServerConfig({ ...realEnvironment, MODEL_MODE: "fake" })).toEqual({ mode: "fake" });
  });

  it("fails clearly in real mode without keys", () => {
    expect(() => getServerConfig({ MODEL_MODE: "real" })).toThrow(
      "Real mode requires: DATABASE_URL, GEMINI_API_KEY, GEMINI_EVAL_API_KEY, GROQ_API_KEY. Use MODEL_MODE=fake for offline work.",
    );
  });

  it("reports a missing individual key without echoing configured values", () => {
    const env = { ...realEnvironment, GROQ_API_KEY: "  " };
    expect(() => getServerConfig(env)).toThrow(
      "Real mode requires: GROQ_API_KEY. Use MODEL_MODE=fake for offline work.",
    );
  });

  it("rejects unknown modes", () => {
    expect(() => getServerConfig({ MODEL_MODE: "typo" })).toThrow("MODEL_MODE must be fake or real.");
  });

  it("validates the database URL without echoing it", () => {
    expect(() => getServerConfig({ ...realEnvironment, DATABASE_URL: "invalid" })).toThrow(
      "DATABASE_URL must be a valid Postgres URL.",
    );
    expect(() => getServerConfig({ ...realEnvironment, DATABASE_URL: "https://example.test" })).toThrow(
      "DATABASE_URL must use postgres:// or postgresql://.",
    );
  });

  it("requires a separate evaluation key", () => {
    expect(() => getServerConfig({ ...realEnvironment, GEMINI_EVAL_API_KEY: realEnvironment.GEMINI_API_KEY })).toThrow(
      "GEMINI_EVAL_API_KEY must be separate from GEMINI_API_KEY.",
    );
  });

  it("accepts complete real configuration without contacting services", () => {
    expect(getServerConfig(realEnvironment)).toEqual({
      mode: "real",
      databaseUrl: realEnvironment.DATABASE_URL,
      geminiApiKey: realEnvironment.GEMINI_API_KEY,
      geminiEvalApiKey: realEnvironment.GEMINI_EVAL_API_KEY,
      groqApiKey: realEnvironment.GROQ_API_KEY,
    });
  });

  it("passes no secret in client props or rendered client output", () => {
    const props = { config: getClientConfig(getServerConfig(realEnvironment)) };
    expect(props).toEqual({ config: { mode: "real" } });
    const serialized = JSON.stringify(props);
    const html = renderToStaticMarkup(createElement(ScaffoldStatus, props));
    for (const value of Object.values(realEnvironment).filter((value) => value !== "real")) {
      expect(serialized).not.toContain(value);
      expect(html).not.toContain(value);
    }
  });

  it("marks the configuration module as server-only", () => {
    const source = readFileSync(new URL("../../src/lib/config.ts", import.meta.url), "utf8");
    expect(source).toContain('import "server-only";');
  });
});
