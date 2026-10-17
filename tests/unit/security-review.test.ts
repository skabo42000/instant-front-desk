import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProviderStop } from "../../src/lib/provider-stop";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { createSupabaseRpc, databaseRpc, PostgresProviderBudget } from "../../src/lib/shared-controls";

let db: PGlite;
const stopDirectory = mkdtempSync(join(tmpdir(), "ifd-stop-test-"));
const localStop = new LocalProviderStop(stopDirectory);
afterAll(() => rmSync(stopDirectory, { recursive: true, force: true }));
beforeAll(async () => { db = await openDatabase(); }, 30000);
afterAll(async () => { await db?.close(); });

it("persists a stop before the first reservation and refuses after restart", async () => {
  const budget = new PostgresProviderBudget(databaseRpc(db), localStop);
  await budget.stop();
  await budget.stop();
  expect(await new PostgresProviderBudget(databaseRpc(db), new LocalProviderStop(join(stopDirectory, "observer"))).reserve(60)).toBe(false);
  expect((await db.query("SELECT used,stopped FROM pilot_budget")).rows).toEqual([{used:0,stopped:true}]);
});

it("does not grant public callers the replacement stop function", async () => {
  await db.exec("CREATE ROLE stop_unprivileged NOLOGIN; SET ROLE stop_unprivileged");
  try {
    await expect(db.query("SELECT ifd_stop_calls()")).rejects.toThrow("permission denied");
  } finally { await db.exec("RESET ROLE"); }
});

it("cancels oversized chunked RPC replies before reading the remaining body", async () => {
  const cancel = vi.fn();
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1_000_001)); }, cancel,
  }, { highWaterMark: 0 });
  const rpc = createSupabaseRpc({SUPABASE_URL:"https://fixture.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"fixture-service-key-not-real"},
    async () => new Response(body));
  await expect(rpc("ifd_read", {})).rejects.toThrow("Shared database unavailable");
  expect(cancel).toHaveBeenCalledOnce();
  expect(chunks).toBe(2);
});

it.each([200, 201, 204])("accepts an empty successful void RPC response (%s) as null", async status => {
  const rpc = createSupabaseRpc({ SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key-not-real" },
    async () => new Response(null, { status }));
  await expect(rpc("ifd_stop_calls", {})).resolves.toBeNull();
  const budget = new PostgresProviderBudget(rpc, new LocalProviderStop(join(stopDirectory, `void-${status}`)));
  await expect(budget.stop()).resolves.toBeUndefined();
  await expect(budget.reserve(60)).resolves.toBe(false);
});

it("still rejects invalid, oversized, failed and raw or escaped credential-echo RPC replies", async () => {
  const key = "fixture-service-key-not-real";
  const escaped = key.split("").map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  for (const reply of [
    () => new Response(" "),
    () => new Response(null, { status: 500 }),
    () => new Response(null, { headers: { "content-length": "2000001" } }),
    () => Response.json({ echo: key }),
    () => new Response(`{"echo":"${escaped}"}`),
  ]) {
    const rpc = createSupabaseRpc({ SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: key }, async () => reply());
    await expect(rpc("ifd_stop_calls", {})).rejects.toThrow("Shared database unavailable");
  }
});
