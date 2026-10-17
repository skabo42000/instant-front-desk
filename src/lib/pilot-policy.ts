import "server-only";
type Environment = Readonly<Record<string, string | undefined>>;
export function pilotConfigurationIssues(env: Environment): string[] {
  if (env.IFD_PILOT_MODE !== "yes") return ["Pilot mode is disabled"];
  const issues: string[] = [];
  if (env.IFD_DATA_STORE !== "supabase") issues.push("Persistent Supabase data store required");
  if (env.RATE_LIMIT_STORE !== "supabase") issues.push("Shared rate limits required");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(env.SUPABASE_URL ?? "") || (env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0) < 20) issues.push("Server-only shared database credentials required");
  if ((env.PILOT_ACCESS_TOKEN?.length ?? 0) < 32) issues.push("Pilot invitation password must be at least 32 characters");
  if (env.LOCAL_CHAT_MODE !== "real" || env.FREE_TIER_CONFIRMED !== "yes") issues.push("Confirmed free-only real chat required");
  if (!env.GEMINI_EVAL_API_KEY || !env.GROQ_EVAL_API_KEY) issues.push("Isolated evaluation provider keys required");
  const cap = Number(env.LOCAL_CHAT_MAX_CALLS);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 60) issues.push("Pilot provider-call cap must be 1 to 60");
  const ids = (env.PILOT_BUSINESS_IDS ?? "").split(",").map(v => v.trim());
  if (ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) issues.push("Exactly two approved owned-site business IDs required");
  const hashes = (env.PILOT_BENCHMARK_HASHES ?? "").split(",");
  if (hashes.length !== 2 || hashes.some(v => !/^[a-f0-9]{64}$/.test(v))) issues.push("Two accepted benchmark hashes required");
  if (env.PILOT_ACCEPTANCE_CONFIRMED !== "yes") issues.push("Reviewed benchmark, judge calibration, concurrency and security acceptance required");
  try {
    const origin = new URL(env.PILOT_PUBLIC_ORIGIN ?? "");
    if (origin.protocol !== "https:" || origin.origin !== env.PILOT_PUBLIC_ORIGIN) throw new Error();
  } catch { issues.push("Exact HTTPS pilot origin required"); }
  return issues;
}
