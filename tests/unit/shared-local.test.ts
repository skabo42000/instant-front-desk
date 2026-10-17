import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { directRpc, loadMigrations, main, MIGRATIONS, SCOPE, summarizeRace, validateDataRoot } from "../../scripts/shared-local";

describe("local Postgres proof (no server)", () => {
  it("rejects the project, children and any OneDrive directory", () => {
    for (const root of ["/work/project", "/work/project/db", "/users/me/OneDrive-Personal/db"]) {
      expect(() => validateDataRoot(root, "/work/project")).toThrow();
    }
    expect(() => validateDataRoot("/work/project-other", "/work/project")).not.toThrow();
    expect(() => validateDataRoot("/users/me/ifd-postgres", "/work/project")).not.toThrow();
  });
  it("loads all eight unchanged migrations in order with hashes", async () => {
    const migrations = await loadMigrations(process.cwd());
    expect(migrations.map(m => m.name)).toEqual(MIGRATIONS);
    expect(migrations).toHaveLength(8);
    for (const migration of migrations) {
      expect(migration.sql).toBe(await readFile(join("db", migration.name), "utf8"));
      expect(migration.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(migrations[0].sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });
  it("fails closed when a migration cannot be loaded", async () => {
    await expect(loadMigrations(join(process.cwd(), "not-a-project"))).rejects.toThrow();
  });
  it("requires 24 results, exactly three accepts and zero errors", () => {
    const results: PromiseSettledResult<boolean>[] = Array.from({ length: 24 }, (_, i) => ({ status: "fulfilled", value: i < 3 }));
    expect(summarizeRace(results)).toMatchObject({ pass: true, accepted: 3, errors: 0 });
    expect(summarizeRace(results.slice(0, 23)).pass).toBe(false);
    results[23] = { status: "rejected", reason: new Error("offline") };
    expect(summarizeRace(results)).toMatchObject({ pass: false, errors: 1 });
    results[23] = { status: "fulfilled", value: true };
    expect(summarizeRace(results)).toMatchObject({ pass: false, accepted: 4 });
  });
  it("uses only allowlisted parameterized direct SQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ value: false }] });
    const rpc = directRpc({ query });
    expect(await rpc("ifd_consume_rate", { entries: [{ key: "untrusted'" }], window_ms: 60000 })).toBe(false);
    expect(query).toHaveBeenLastCalledWith("SELECT ifd_consume_rate($1::jsonb,$2) AS value", ['[{"key":"untrusted\u0027"}]', 60000]);
    await rpc("ifd_reserve_call", { max_calls: 60 });
    expect(query).toHaveBeenLastCalledWith("SELECT ifd_reserve_call($1) AS value", [60]);
    await rpc("ifd_stop_calls", {});
    expect(query).toHaveBeenLastCalledWith("SELECT ifd_stop_calls() AS value", []);
    await expect(rpc("arbitrary_sql", {})).rejects.toThrow("Unknown local RPC");
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("propagates database errors instead of accepting reservations", async () => {
    const rpc = directRpc({ query: vi.fn().mockRejectedValue(new Error("unavailable")) });
    await expect(rpc("ifd_reserve_call", { max_calls: 60 })).rejects.toThrow("unavailable");
    await expect(rpc("ifd_stop_calls", {})).rejects.toThrow("unavailable");
  });
  it("dry run writes an honest migration-only report and refuses overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ifd-proof-unit-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const file = join(dir, "dry.json");
      await main(["--dry-run", file]);
      const report = JSON.parse(await readFile(file, "utf8"));
      expect(report).toMatchObject({ pass: true, dryRun: true, scope: SCOPE, dataDirectory: null, serverVersion: null });
      expect(report.checks).toEqual({ migrationLoading: expect.objectContaining({ pass: true, count: 8 }) });
      expect(report.cleanup.required).toBe(false);
      await expect(main(["--dry-run", file])).rejects.toThrow();
    } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
});
