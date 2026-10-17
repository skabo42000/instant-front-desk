import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../src/lib/mcp/adapter";
export async function main() {
  await createMcpServer(process.env).connect(new StdioServerTransport());
}
