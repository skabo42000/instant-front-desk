import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next enforces this boundary at build time; unit tests run outside Next.
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url)),
    },
  },
  // One file at a time: each test file starts its own in-memory Postgres (~390 MB); parallel runs time out on this PC.
  // Test reports go to a temp folder, never next to real run reports.
  test: { env: { IFD_OUTPUT_ROOT: join(tmpdir(), "ifd-test-output") }, environment: "node", include: ["tests/**/*.test.ts"], fileParallelism: false, hookTimeout: 60000 },
});
