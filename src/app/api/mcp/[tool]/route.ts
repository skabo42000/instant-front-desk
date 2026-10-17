import { createMcpReadHandler } from "../../../../lib/mcp/api";
import { getLocalDatabase } from "../../../../lib/local-businesses";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request:Request,context:{params:Promise<{tool:string}>}) {
  return createMcpReadHandler(getLocalDatabase,process.env)(request,(await context.params).tool);
}
