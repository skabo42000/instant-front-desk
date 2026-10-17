import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProviderStop } from "../../src/lib/provider-stop";
import { PostgresProviderBudget, type Rpc } from "../../src/lib/shared-controls";
import { createChatRuntime } from "../../src/lib/chat-runtime";

const directories: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "ifd-pending-stop-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("writes only a constant marker and keeps it across repeated stops and fresh store objects", () => {
  const dir = directory();
  const store = new LocalProviderStop(dir);
  expect(store.exists()).toBe(false);
  store.mark(); store.mark();
  expect(new LocalProviderStop(dir).exists()).toBe(true);
  expect(readFileSync(join(dir, "quota-stop"), "utf8")).toBe("quota-stop-v1\n");
});

it("replays an unsaved stop before any reservation after recovery, including another budget object", async () => {
  const dir = directory();
  let unavailable = true, sharedStopped = false;
  const calls: string[] = [];
  const rpc: Rpc = async <T>(name: string): Promise<T> => {
    calls.push(name);
    if (unavailable) throw Error("DB offline");
    if (name === "ifd_stop_calls") sharedStopped = true;
    return !sharedStopped as T;
  };
  const first = new PostgresProviderBudget(rpc, new LocalProviderStop(dir));
  await expect(first.stop()).rejects.toThrow("DB offline");
  await expect(new PostgresProviderBudget(rpc, new LocalProviderStop(dir)).reserve(60)).rejects.toThrow("DB offline");
  unavailable = false;
  expect(await new PostgresProviderBudget(rpc, new LocalProviderStop(dir)).reserve(60)).toBe(false);
  expect(sharedStopped).toBe(true);
  expect(calls).toEqual(["ifd_stop_calls", "ifd_stop_calls", "ifd_stop_calls"]);
  // A DB reset alone cannot silently clear the local stop.
  sharedStopped = false;
  expect(await new PostgresProviderBudget(rpc, new LocalProviderStop(dir)).reserve(60)).toBe(false);
  expect(sharedStopped).toBe(true);
});

it.each([429, 403])("quota %s during DB outage persists through a fresh runtime with zero further HTTP calls", async status => {
  const dir = directory();
  let unavailable = false, sharedStopped = false;
  const rpc: Rpc = async <T>(name: string): Promise<T> => {
    if (unavailable) throw Error("offline");
    if (name === "ifd_stop_calls") sharedStopped = true;
    return !sharedStopped as T;
  };
  const http = vi.fn(async () => {
    unavailable = true;
    return Response.json({ error: "quota exceeded" }, { status });
  });
  const env = { LOCAL_CHAT_MODE: "real", FREE_TIER_CONFIRMED: "yes", GEMINI_EVAL_API_KEY: "synthetic", GROQ_EVAL_API_KEY: "synthetic" };
  const runtime = () => createChatRuntime(env, http, new PostgresProviderBudget(rpc, new LocalProviderStop(dir)));
  await expect(runtime()("gemini-embedding-001").embeddings.embed("hours")).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
  unavailable = false;
  await expect(runtime()("gemini-embedding-001").embeddings.embed("hours")).rejects.toMatchObject({ code: "FREE_TIER_EXHAUSTED" });
  expect(http).toHaveBeenCalledTimes(1);
  expect(sharedStopped).toBe(true);
});

it("does not call the reservation RPC when local storage is unusable", async () => {
  const dir = directory();
  const file = join(dir, "file"); writeFileSync(file, "fixture");
  const rpc = vi.fn();
  const budget = new PostgresProviderBudget(rpc as Rpc, new LocalProviderStop(file));
  await expect(budget.reserve(60)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});

it("keeps the in-memory latch and attempts the DB stop even if the local write fails", async () => {
  const dir = directory();
  const file = join(dir, "file"); writeFileSync(file, "fixture");
  const rpc = vi.fn().mockResolvedValue(undefined);
  const budget = new PostgresProviderBudget(rpc as Rpc, new LocalProviderStop(file));
  await expect(budget.stop()).rejects.toThrow("Local provider stop unavailable");
  expect(await budget.reserve(60)).toBe(false);
  expect(rpc.mock.calls.map(call => call[0])).toEqual(["ifd_stop_calls", "ifd_stop_calls"]);
});

it("treats an empty or damaged marker as a stop without parsing its contents", async () => {
  const dir = directory(); writeFileSync(join(dir, "quota-stop"), "");
  const rpc = vi.fn().mockResolvedValue(undefined);
  expect(await new PostgresProviderBudget(rpc as Rpc, new LocalProviderStop(dir)).reserve(60)).toBe(false);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("ifd_stop_calls", {});
});

it("rejects a symlinked stop directory and never overwrites a symlinked marker", () => {
  const dir = directory(), target = directory();
  const link = join(dir, "link"); symlinkSync(target, link, "dir");
  expect(() => new LocalProviderStop(link).exists()).toThrow();
  const file = join(target, "target"); writeFileSync(file, "unchanged");
  symlinkSync(file, join(dir, "quota-stop"));
  const store = new LocalProviderStop(dir); store.mark();
  expect(store.exists()).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("unchanged");
});
