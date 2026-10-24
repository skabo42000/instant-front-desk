type Environment = Readonly<Record<string, string | undefined>>;

export function chatRequestOriginAllowed(request: Request, env: Environment = process.env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (env.IFD_PILOT_MODE === "yes") return origin === env.PILOT_PUBLIC_ORIGIN;
  const url = new URL(request.url);
  let expected = url.origin;
  const host = request.headers.get("host");
  // Next may normalize a local listener's URL to localhost. Honor the browser's
  // Host only for a direct loopback URL and a strictly loopback Host.
  if (host && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    try {
      const browserUrl = new URL(`${url.protocol}//${host}`);
      if (browserUrl.host === host.toLowerCase() &&
          ["localhost", "127.0.0.1", "[::1]"].includes(browserUrl.hostname)) expected = browserUrl.origin;
    } catch { return false; }
  }
  return origin === expected;
}
