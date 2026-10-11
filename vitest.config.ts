import { fileURLToPath } from "node:url";
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
  test: { environment: "node", include: ["tests/**/*.test.ts"], fileParallelism: false, hookTimeout: 60000 },
});
