import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cachedEmbeddings } from "../../src/lib/models/embedding-cache";
import { outputPath } from "../../src/lib/output-path";

const directory = () => outputPath("data/embedding-cache-tests", randomUUID());
const adapter = (model = "fixture-model", dimensions = 3) => ({
  model, dimensions, embed: vi.fn(async () => Array(dimensions).fill(0.5)),
});

it("reuses vectors from disk across adapters, and only embeds changed chunks", async () => {
  const folder = directory();
  const first = adapter();
  const cache = cachedEmbeddings(first, folder);
  await cache.embed("Hours: 9 to 5");
  await cache.embed("Phone: fixture");
  expect(first.embed).toHaveBeenCalledTimes(2);
  const second = adapter();
  const rerun = cachedEmbeddings(second, folder);
  expect(await rerun.embed("Hours: 9 to 5")).toEqual([0.5, 0.5, 0.5]);
  await rerun.embed("Phone: fixture");
  expect(second.embed).not.toHaveBeenCalled();
  await rerun.embed("Hours: 10 to 5");
  expect(second.embed).toHaveBeenCalledExactlyOnceWith("Hours: 10 to 5");
  for (const file of await readdir(folder)) {
    const content = await readFile(join(folder, file), "utf8");
    expect(content).not.toContain("Hours:");
    expect(content).not.toContain("Phone:");
  }
});

it("model and dimensions isolate vector spaces", async () => {
  const folder = directory();
  await cachedEmbeddings(adapter(), folder).embed("same chunk");
  const otherModel = adapter("another-model");
  const otherDimensions = adapter("fixture-model", 2);
  await cachedEmbeddings(otherModel, folder).embed("same chunk");
  await cachedEmbeddings(otherDimensions, folder).embed("same chunk");
  expect(otherModel.embed).toHaveBeenCalledTimes(1);
  expect(otherDimensions.embed).toHaveBeenCalledTimes(1);
});

it("replaces malformed or wrong-dimension cache entries", async () => {
  for (const corrupt of ["invalid json", JSON.stringify({ model: "fixture-model", dimensions: 3, values: [1] })]) {
    const folder = directory();
    await cachedEmbeddings(adapter(), folder).embed("chunk");
    const [file] = await readdir(folder);
    await writeFile(join(folder, file), corrupt);
    const next = adapter();
    expect(await cachedEmbeddings(next, folder).embed("chunk")).toEqual([0.5, 0.5, 0.5]);
    expect(next.embed).toHaveBeenCalledTimes(1);
  }
});

it("failed or invalid embeddings are never cached", async () => {
  const folder = directory();
  const inner = adapter();
  inner.embed.mockRejectedValueOnce(new Error("fixture failure")).mockResolvedValueOnce([1]);
  const cache = cachedEmbeddings(inner, folder);
  await expect(cache.embed("chunk")).rejects.toThrow("fixture failure");
  await expect(cache.embed("chunk")).rejects.toThrow("Invalid embedding");
  await cache.embed("chunk");
  expect(inner.embed).toHaveBeenCalledTimes(3);
});
