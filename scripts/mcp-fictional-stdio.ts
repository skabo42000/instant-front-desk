import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../src/lib/mcp/adapter";
import { createFictionalService, startFictionalApi } from "./mcp-fictional-api";
import fixture from "../tests/fixtures/mcp-maple-street-dental.json";

export async function main() {
  // Ignore inherited app settings. Nothing loads .env.local or a saved database.
  const token = randomBytes(32).toString("hex");
  const api = process.argv.includes("--loopback")
    ? await startFictionalApi({ IFD_MCP_TOKEN: token }) : await createFictionalService({ IFD_MCP_TOKEN: token });
  const server = createMcpServer({ IFD_MCP_ORIGIN: api.origin, IFD_MCP_TOKEN: token,
    IFD_MCP_BUSINESS_IDS: fixture.business.businessId }, "transport" in api ? api.transport : undefined);
  let closing: Promise<void> | undefined;
  const stop = () => closing ??= (async () => { await server.close(); await api.close(); })();
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.stdin.once("end", () => { void stop(); });
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { await stop(); throw error; }
}
