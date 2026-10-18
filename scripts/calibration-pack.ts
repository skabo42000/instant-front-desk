import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { benchmarkHash, loadSnapshot, type Benchmark } from "../src/lib/eval/benchmark";
import { businessRepository } from "../src/lib/db/repository";
import { calibrationPage, compareCalibration, makeCalibrationPack } from "../src/lib/eval/calibration-pack";

async function savedBundles(root: string): Promise<Benchmark[]> {
  const bundles: Benchmark[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bundles.push(...await savedBundles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value.schema === 1 && value.snapshot && Array.isArray(value.cases)) bundles.push(value);
      } catch { /* Unrelated saved JSON is not a benchmark bundle. */ }
    }
  }
  return bundles;
}

export async function packMain(args: string[]) {
  if (args.length < 2 || !args[0].endsWith(".html")) throw new Error("Supply OUT_HTML REPORT_JSON [REPORT_JSON...]");
  const output = resolve(args[0]);
  const root = resolve("data/calibration");
  if (!output.startsWith(root + "/")) throw new Error("Output must be under data/calibration/");
  const reports = await Promise.all(args.slice(1).map(async p => JSON.parse(await readFile(p, "utf8"))));
  const bundles = await savedBundles(resolve("data/benchmarks"));
  const inputs = [];
  for (const report of reports) {
    const benchmark = bundles.find(b => benchmarkHash(b) === report.benchmarkHash && b.snapshotHash === report.snapshotHash);
    if (!benchmark) throw new Error("No matching frozen benchmark under data/benchmarks/");
    // Reuse the actual Postgres query, including its ordering, to reconstruct judge contact evidence.
    const db = new PGlite({ extensions: { vector } });
    try {
      const { readFileSync } = await import("node:fs");
      await db.exec(readFileSync(resolve("db/001_initial.sql"), "utf8"));
      await loadSnapshot(db, benchmark);
      const repo = businessRepository(db, benchmark.snapshot.business.businessId);
      const contactEvidence = (await repo.searchChunksByPattern(
        "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}|\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}", benchmark.snapshot.business.embeddingModel, 3,
      )).map(({ id, pageUrl, heading, text }) => ({ id, pageUrl, heading, text }));
      inputs.push({ report, benchmark, contactEvidence });
    } finally { await db.close(); }
  }
  const pack = makeCalibrationPack(inputs);
  await mkdir(dirname(output), { recursive: true });
  const jsonPath = output.replace(/\.html$/, ".json");
  // Exclusive creation prevents overwriting saved reports or earlier human work.
  await writeFile(jsonPath, JSON.stringify(pack, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(output, calibrationPage(pack), { flag: "wx", mode: 0o600 });
  console.log(`Saved ${pack.cases.length} cases: ${output} and ${jsonPath}`);
}

export async function compareMain(args: string[]) {
  if (args.length !== 5 || args[3] !== "--reviewer") throw new Error("Supply PACK_JSON LABELS_JSON OUT_JSON --reviewer Bosko");
  const [pack, labels] = await Promise.all(args.slice(0,2).map(async p => JSON.parse(await readFile(p, "utf8"))));
  const result = compareCalibration(pack, labels, args[4]);
  await mkdir(dirname(resolve(args[2])), { recursive: true });
  await writeFile(args[2], JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Agreement: ${result.agreements}/${result.sampleSize}; ${result.disagreements.length} disagreements (including explicit dimensions).`);
}
