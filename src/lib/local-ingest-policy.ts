import "server-only";

type Environment = Readonly<Record<string, string | undefined>>;
type RequestHeaders = Pick<Headers, "get">;

function loopbackHost(host: string | null): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return url.host === host.toLowerCase() && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

export function localIngestAllowed(headers: RequestHeaders, env: Environment = process.env): boolean {
  // Next supplies these even for direct requests; reject remote/proxied values.
  const forwardedFor = headers.get("x-forwarded-for");
  const forwardedHost = headers.get("x-forwarded-host");
  return env.IFD_PILOT_MODE !== "yes" && !env.PILOT_ACCESS_TOKEN?.trim() &&
    (!env.IFD_DATA_STORE || env.IFD_DATA_STORE === "local") &&
    env.LOCAL_CHAT_MODE === "real" && env.FREE_TIER_CONFIRMED === "yes" &&
    loopbackHost(headers.get("host")) && !headers.get("forwarded") &&
    (!forwardedFor || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(forwardedFor)) &&
    (!forwardedHost || forwardedHost === headers.get("host"));
}

export function localIngestRequestAllowed(request: Request, env: Environment = process.env): boolean {
  return localIngestAllowed(request.headers, env) && loopbackHost(new URL(request.url).host);
}
