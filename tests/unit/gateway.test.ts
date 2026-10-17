import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelGateway, assertIndependentJudge, type AnswerProvider } from "../../src/lib/models/gateway";
import { FakeModel } from "../../src/lib/models/fake";
import type { ModelAdapter, ModelRequest } from "../../src/lib/types";

const request: ModelRequest = { businessId: "test", question: "Hours?", sources: [] };
const reply = { text: "9 am.", citedChunkIds: ["hours"] };
const provider = (adapter: ModelAdapter, name = "primary", family = "gemini"): AnswerProvider => ({
  provider: name, model: "scripted", family, adapter,
});
afterEach(() => vi.useRealTimers());

describe("fake-first gateway", () => {
  it("defaults to fake mode and fails closed without scripted replies", async () => {
    const result = await new ModelGateway().generate(request);
    expect(result.ok).toBe(false);
    expect(result.logs).toHaveLength(2);
    expect(result.logs.every((log) => log.provider === "fake")).toBe(true);
  });
  it("logs tokens and leaves unknown cost unknown", async () => {
    const onLog = vi.fn();
    const gateway = new ModelGateway({ primary: provider(new FakeModel([{ ...reply, usage: { inputTokens: 12, outputTokens: 4 } }])), onLog });
    const result = await gateway.generate(request);
    expect(result.ok).toBe(true);
    expect(result.logs[0]).toEqual({ provider: "primary", model: "scripted", attempt: 1, status: "success", latencyMs: expect.any(Number), inputTokens: 12, outputTokens: 4, estimatedCost: null, priceVersion: "public-list-usd-2026-10-15" });
    expect(onLog).toHaveBeenCalledWith(result.logs[0]);
  });
  it("missing usage is null, not zero", async () => {
    const result = await new ModelGateway({ primary: provider(new FakeModel([reply])) }).generate(request);
    expect(result.logs[0].inputTokens).toBeNull();
    expect(result.logs[0].outputTokens).toBeNull();
    expect(result.logs[0].estimatedCost).toBeNull();
  });
  it("retries once then uses one fallback provider", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("failure"));
    const fallbackAdapter = new FakeModel([reply]);
    const fallback = vi.spyOn(fallbackAdapter, "generate");
    const result = await new ModelGateway({ primary: provider({ generate }), fallback: provider(fallbackAdapter, "fallback", "llama") }).generate(request);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.logs.map((log) => log.status)).toEqual(["error", "error", "success"]);
    expect(result.ok && result.family).toBe("llama");
  });
  it("stops retrying after success", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(reply);
    const fallback = vi.fn();
    const result = await new ModelGateway({ primary: provider({ generate }), fallback: provider({ generate: fallback }, "fallback") }).generate(request);
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("can disable retry and never retries fallback", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("failure"));
    const fallback = vi.fn().mockRejectedValue(new Error("failure"));
    const result = await new ModelGateway({ primary: provider({ generate }), fallback: provider({ generate: fallback }, "fallback"), retry: false }).generate(request);
    expect(result.ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it("aborts timed out attempts and can recover via fallback", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const generate: ModelAdapter["generate"] = (_request, options) => {
      signals.push(options!.signal);
      return new Promise(() => {});
    };
    const pending = new ModelGateway({ primary: provider({ generate }), fallback: provider(new FakeModel([reply]), "fallback"), attemptTimeoutMs: 10, totalTimeoutMs: 50 }).generate(request);
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.logs.map((log) => log.status)).toEqual(["timeout", "timeout", "success"]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it("total deadline caps the whole request, including retry and fallback", async () => {
    vi.useFakeTimers();
    const generate = vi.fn(() => new Promise<never>(() => {}));
    const fallback = vi.fn();
    const pending = new ModelGateway({ primary: provider({ generate }), fallback: provider({ generate: fallback }, "fallback"), totalTimeoutMs: 15, attemptTimeoutMs: 10 }).generate(request);
    await vi.advanceTimersByTimeAsync(15);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.logs.map((log) => log.latencyMs)).toEqual([10, 5]);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("rejects same-provider fallback and invalid budgets", () => {
    const primary = provider(new FakeModel([]));
    expect(() => new ModelGateway({ primary, fallback: primary })).toThrow("another provider");
    expect(() => new ModelGateway({ totalTimeoutMs: 0 })).toThrow("positive");
  });
  it("keeps judge family separate for primary and fallback answers", () => {
    expect(() => assertIndependentJudge("claude", { provider: "anthropic", model: "judge", family: "Claude" })).toThrow("different model family");
    expect(() => assertIndependentJudge("llama", { provider: "groq", model: "judge", family: "llama" })).toThrow();
    expect(() => assertIndependentJudge("gemini", { provider: "groq", model: "judge", family: "llama" })).not.toThrow();
  });
});
