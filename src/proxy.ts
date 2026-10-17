import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { pilotConfigurationIssues } from "./lib/pilot-policy";

export function proxy(request: NextRequest) {
  if (process.env.IFD_PILOT_MODE !== "yes" || request.nextUrl.pathname === "/api/health") return NextResponse.next();
  const deny = (text: string, status: number, reason: string, headers: Record<string,string> = {}) => {
    const requestId = randomUUID();
    try { console.info(JSON.stringify({ schema: 1, event: "pilot.denied", at: new Date().toISOString(), requestId, status, reason })); } catch { /* Logging is observational. */ }
    return new NextResponse(text, { status, headers: { "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers } });
  };
  if (process.env.PILOT_PAUSED === "yes" || pilotConfigurationIssues(process.env).length) return deny("Pilot temporarily unavailable.", 503, "pilot-unavailable");
  const authorization = request.headers.get("authorization") ?? "";
  let supplied = "";
  if (authorization.startsWith("Basic ") && authorization.length < 1000) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    if (decoded.startsWith("pilot:")) supplied = decoded.slice(6);
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(process.env.PILOT_ACCESS_TOKEN!))) {
    return deny("Invitation required.", 401, "invitation-required",
      { "WWW-Authenticate": 'Basic realm="Instant Front Desk pilot", charset="UTF-8"' });
  }
  if (request.method === "POST" && request.headers.get("origin") !== process.env.PILOT_PUBLIC_ORIGIN) return deny("Request origin is not allowed.", 403, "cross-origin");
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
