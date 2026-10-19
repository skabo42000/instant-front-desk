import { afterEach, expect, it, vi } from "vitest";
import { benchmarkPause } from "../../scripts/benchmark";
import { GroqQualityJudge } from "../../src/lib/eval/benchmark-runner";
import type { BenchmarkCase } from "../../src/lib/eval/benchmark";
import { guardedRequestDeadlineMs, guardedTransport } from "../../scripts/live";

afterEach(() => vi.useRealTimers());
it("paces the next case for 20 seconds before starting the judge's 21-second deadline", async () => {
  vi.useFakeTimers();
  const verdict = { grounded: true, complete: true, correctBehavior: true, reason: "Synthetic verdict." };
  const transport = vi.fn(async () => {
    await new Promise(done => setTimeout(done, 2000));
    return Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
  });
  const judge = new GroqQualityJudge("synthetic-test-key", transport, undefined, 21000);
  const run = (async () => {
    await benchmarkPause(undefined)();
    return judge.grade({ question: "Unlisted fact?", requiredFacts: [] } as unknown as BenchmarkCase,
      { kind: "refusal", text: "Not listed.", citations: [], logs: [] }, [], []);
  })();
  await vi.advanceTimersByTimeAsync(19999);
  expect(transport).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(transport).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  await expect(run).resolves.toEqual(verdict);
  expect(vi.getTimerCount()).toBe(0);
});
it("respects explicit pacing and rejects malformed waits before any calls", async () => {
  vi.useFakeTimers();
  for (const value of ["0", "20000", "60000"]) {
    const done = vi.fn();
    const wait = benchmarkPause(value)().then(done);
    await vi.advanceTimersByTimeAsync(Number(value));
    await wait;
    expect(done).toHaveBeenCalledOnce();
  }
  for (const value of ["", " ", "-1", "NaN", "Infinity", "60001", "1.5"]) expect(() => benchmarkPause(value)).toThrow("Invalid BENCHMARK_PAUSE_MS");
});
it("lets the judge finish three 61-second rate waits plus a transient retry without a deadline error", async () => {
  vi.useFakeTimers();
  const verdict = { grounded: true, complete: true, correctBehavior: true, reason: "Synthetic rate-wait recovery." };
  const transport = vi.fn(async (): Promise<Response> => {
    const call = transport.mock.calls.length;
    await new Promise(done => setTimeout(done, 19000));
    return call <= 3
      ? new Response("per-minute token rate limit", { status: 429, headers: { "retry-after": "60" } })
      : call === 4 ? new Response("Temporary failure", { status: 503 })
      : Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
  });
  const guard = guardedTransport(transport, 100, [], 20000);
  expect(guardedRequestDeadlineMs(20000)).toBe(285000);
  const judge = new GroqQualityJudge("synthetic-test-key", guard.transport, undefined, guardedRequestDeadlineMs(20000));
  const run = judge.grade({ question: "Unlisted fact?", requiredFacts: [] } as unknown as BenchmarkCase,
    { kind: "refusal", text: "Not listed.", citations: [], logs: [] }, [], []);
  await vi.advanceTimersByTimeAsync(3 * 61000 + 5 * 19000 + 1000);
  await expect(run).resolves.toEqual(verdict);
  expect(guard.callsUsed()).toBe(5);
  expect(guard.stopReason()).toBeNull();
  expect(guard.callLogs().map(log => log.status)).toEqual([
    "rate-limited (per-minute), waited", "rate-limited (per-minute), waited", "rate-limited (per-minute), waited", "HTTP 503", "success",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
