import { createMcpReadHandler } from "../../../../lib/mcp/api";
import { getLocalDatabase } from "../../../../lib/local-businesses";
import { handleChatRequest } from "../../../../lib/chat-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createMcpReadHandler(getLocalDatabase,process.env,handleChatRequest);
export async function POST(request:Request,context:{params:Promise<{tool:string}>}) {
  return handler(request,(await context.params).tool);
}
