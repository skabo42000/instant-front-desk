import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase } from "../../src/lib/db/client";
import { createSupabaseRpc, databaseRpc, PostgresProviderBudget } from "../../src/lib/shared-controls";

let db: PGlite;
beforeAll(async () => { db = await openDatabase(); }, 30000);
afterAll(async () => { await db?.close(); });

it("persists a stop before the first reservation and refuses after restart", async () => {
  const budget = new PostgresProviderBudget(databaseRpc(db));
  await budget.stop();
  await budget.stop();
  expect(await new PostgresProviderBudget(databaseRpc(db)).reserve(60)).toBe(false);
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
