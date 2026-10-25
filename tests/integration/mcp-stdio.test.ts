import { expect, it } from "vitest";
// @ts-expect-error Standalone Node script has no declaration file.
import { fictionalStdioSession } from "../../scripts/check-mcp-fictional.mjs";

it("discovers and calls all four tools over real child-process stdio, with a cited answer, refusal and bad input", async () => {
  const result = await fictionalStdioSession();
  expect(result.tools).toHaveLength(4);
  expect(result.exchanges).toHaveLength(6);
  expect(result.liveModelCalls).toBe(0);
  expect(result.processesStopped).toBe(true);
}, 60000);
