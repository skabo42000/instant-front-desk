import "server-only";
import { createSupabaseRpc, type Rpc } from "./shared-controls";
import { createPostgresRpc } from "./postgres-rpc";

export function createPilotRpc(env: Readonly<Record<string, string | undefined>>): Rpc {
  if (env.IFD_DATA_STORE === "postgres") return createPostgresRpc(env);
  if (env.IFD_DATA_STORE === "supabase") return createSupabaseRpc(env);
  throw Error("Persistent pilot data store required");
}
