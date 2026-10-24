import { describe, expect, it } from "vitest";
import { chatRequestOriginAllowed } from "../../src/lib/request-origin";
const request = (origin: string, host?: string, url = "http://localhost:3000/api/chat") =>
  new Request(url, { headers: { origin, ...(host ? { host } : {}) } });
describe("chat origin boundary", () => {
  it("accepts the direct browser loopback host even when Next normalized the URL", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(chatRequestOriginAllowed(request(`http://${host}`, host), {})).toBe(true);
    }
    expect(chatRequestOriginAllowed(request("http://localhost:3000"), {})).toBe(true);
  });
  it("rejects foreign origins, malformed hosts, different ports and nonloopback host spoofing", () => {
    for (const [origin, host] of [["https://evil.invalid", "evil.invalid"], ["null", "localhost:3000"],
      ["http://127.0.0.1:4000", "127.0.0.1:3000"], ["http://127.0.0.1:3000", "localhost:3000"],
      ["https://evil.invalid", "localhost:3000@evil.invalid"], ["http://localhost:3000", "["]]) {
      expect(chatRequestOriginAllowed(request(origin, host), {})).toBe(false);
    }
    expect(chatRequestOriginAllowed(request("http://127.0.0.1:3000", "127.0.0.1:3000", "https://public.invalid/api/chat"), {})).toBe(false);
  });
  it("keeps pilot mode pinned to the configured public origin", () => {
    const env = { IFD_PILOT_MODE: "yes", PILOT_PUBLIC_ORIGIN: "https://pilot.invalid" };
    expect(chatRequestOriginAllowed(request("https://pilot.invalid", "127.0.0.1:3000"), env)).toBe(true);
    expect(chatRequestOriginAllowed(request("http://127.0.0.1:3000", "127.0.0.1:3000"), env)).toBe(false);
    expect(chatRequestOriginAllowed(request("http://localhost:3000"), { IFD_PILOT_MODE: "yes" })).toBe(false);
  });
});
