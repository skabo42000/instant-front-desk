import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import { assertPublicAddress } from "@/lib/crawl/url-policy";
import { safeFetch, type TransportResponse, type Transport } from "@/lib/crawl/safe-fetch";

const nativeRequests = vi.hoisted(() => ({ http: vi.fn(), https: vi.fn() }));
// Even a regression using the default transport cannot reach the network.
vi.mock("node:http", () => ({ request: nativeRequests.http }));
vi.mock("node:https", () => ({ request: nativeRequests.https }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(() => { throw new Error("Real DNS is forbidden in tests."); }) }));

const publicAddress = { address: "93.184.216.34", family: 4 };
const publicDns = () => Promise.resolve([publicAddress]);
function response(text = "fixture", status = 200, location?: string): TransportResponse {
  return {
    status, headers: location ? { location } : {},
    body: (async function* () { yield Buffer.from(text); })(),
    destroy: vi.fn(),
  };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("URL and address policy", () => {
  it.each([
    ["credentials in URL", "https://user:password@example.test"],
    ["nonstandard port", "https://example.test:8443"],
    ["nonstandard HTTP port", "http://example.test:443"],
    ["unsupported protocol", "file:///fixture"],
    ["loopback", "http://127.0.0.1"],
    ["alternative loopback spelling", "http://2130706433"],
    ["private", "http://10.1.2.3"],
    ["link-local", "http://169.254.169.254"],
    ["IPv6 loopback", "http://[::1]"],
    ["IPv6 private", "http://[fd00::1]"],
    ["IPv6 link-local", "http://[fe80::1]"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]"],
  ])("rejects %s before DNS or transport", async (_, url) => {
    const dns = vi.fn(publicDns);
    const transport = vi.fn<Transport>();
    await expect(safeFetch(url, { dns, transport })).rejects.toThrow();
    expect(dns).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "0.1.2.3", "100.64.0.1", "172.16.0.1", "192.168.1.1", "192.0.0.9",
    "192.0.2.1", "192.88.99.1", "198.18.1.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "255.255.255.255", "::", "::ffff:10.0.0.1", "::ffff:a00:1",
    "::ffff:93.184.216.34", "64:ff9b::a00:1", "ff02::1", "2001:db8::1",
    "2001::1", "2002:7f00:1::", "3fff::1", "fe80::1%lo", "invalid",
  ])("rejects reserved/transition address %s", (address) => {
    expect(() => assertPublicAddress(address)).toThrow();
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts public unicast %s", (address) => expect(assertPublicAddress(address)).toBe(address.includes(":") ? 6 : 4),
  );

  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [publicAddress, { address: "10.0.0.1", family: 4 }],
    [publicAddress, { address: "::ffff:7f00:1", family: 6 }],
    [publicAddress, { address: "fd00::1", family: 6 }],
  ])("rejects private or mixed public/private DNS answers %#", async (...answers) => {
    const transport = vi.fn<Transport>();
    await expect(safeFetch("https://example.test", { dns: async () => answers, transport })).rejects.toThrow("not public");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects empty DNS and mismatched address families", async () => {
    const transport = vi.fn<Transport>();
    await expect(safeFetch("https://example.test", { dns: async () => [], transport })).rejects.toThrow("no addresses");
    await expect(safeFetch("https://example.test", {
      dns: async () => [{ ...publicAddress, family: 6 }], transport,
    })).rejects.toThrow("family mismatch");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("pinned transport and redirects", () => {
  it("pins native HTTP and HTTPS connections and preserves Host/TLS identity", async () => {
    for (const protocol of ["http", "https"]) {
      const native = protocol === "https" ? nativeRequests.https : nativeRequests.http;
      const stream = Readable.from([Buffer.from("offline")]);
      Object.assign(stream, { statusCode: 200, headers: {} });
      const req = Object.assign(new EventEmitter(), { end: vi.fn() });
      native.mockImplementationOnce((_options, callback) => { callback(stream); return req; });
      const result = await safeFetch(`${protocol}://example.test/path?q=1#fragment`, { dns: publicDns });
      expect(result.body.toString()).toBe("offline");
      expect(native).toHaveBeenLastCalledWith(expect.objectContaining({
        hostname: publicAddress.address, family: 4, servername: "example.test",
        headers: { Host: "example.test", "Accept-Encoding": "identity" },
        path: "/path?q=1", agent: false, port: protocol === "https" ? 443 : 80,
      }), expect.any(Function));
      expect(req.end).toHaveBeenCalledOnce();
    }
  });

  it("DNS rebinding: a second lookup differs but the connection uses the first validated address", async () => {
    const dns = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const transport = vi.fn<Transport>(async (request) => {
      expect(request.address).toEqual(publicAddress);
      expect(await dns("example.test")).toEqual([{ address: "127.0.0.1", family: 4 }]);
      return response();
    });
    await expect(safeFetch("https://example.test", { dns, transport })).resolves.toMatchObject({ status: 200 });
    expect(dns).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(["http://10.0.0.1/secret", "https://private.test/secret"])("rejects redirect to a private address: %s", async (location) => {
    const first = response("", 302, location);
    const dns = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const transport = vi.fn<Transport>().mockResolvedValue(first);
    await expect(safeFetch("https://example.test", { dns, transport })).rejects.toThrow("not public");
    expect(transport).toHaveBeenCalledOnce();
    expect(first.destroy).toHaveBeenCalled();
  });

  it("revalidates DNS even on a same-host redirect (rebinding)", async () => {
    const dns = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const transport = vi.fn<Transport>().mockResolvedValue(response("", 301, "/next"));
    await expect(safeFetch("https://example.test", { dns, transport })).rejects.toThrow("not public");
    expect(dns).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("follows a relative public redirect and returns the final URL", async () => {
    const dns = vi.fn(publicDns);
    const transport = vi.fn<Transport>().mockResolvedValueOnce(response("", 307, "/next"))
      .mockResolvedValueOnce(response("done"));
    const result = await safeFetch("https://example.test:443/start", { dns, transport });
    expect(result).toMatchObject({ url: "https://example.test/next", redirects: 1 });
    expect(result.body.toString()).toBe("done");
    expect(dns).toHaveBeenCalledTimes(2);
  });

  it("caps redirect loops and rejects missing Location", async () => {
    const transport = vi.fn<Transport>().mockResolvedValue(response("", 302, "/again"));
    await expect(safeFetch("https://example.test", { dns: publicDns, transport, maxRedirects: 1 })).rejects.toThrow("Redirect limit");
    expect(transport).toHaveBeenCalledTimes(2);
    transport.mockResolvedValue(response("", 302));
    await expect(safeFetch("https://example.test", { dns: publicDns, transport })).rejects.toThrow("Location");
  });

  it("pins literal IPv6 without calling DNS", async () => {
    const dns = vi.fn(publicDns);
    const transport = vi.fn<Transport>().mockResolvedValue(response());
    await safeFetch("https://[2606:4700:4700::1111]", { dns, transport });
    expect(dns).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ address: { address: "2606:4700:4700::1111", family: 6 } }));
  });
});

describe("resource limits", () => {
  it("stops an oversized streamed body before consuming later chunks", async () => {
    let reads = 0;
    const result = response();
    result.body = (async function* () {
      for (const text of ["abc", "def", "never read"]) { reads++; yield Buffer.from(text); }
    })();
    await expect(safeFetch("https://example.test", {
      dns: publicDns, transport: async () => result, maxBytes: 5,
    })).rejects.toThrow("byte limit");
    expect(reads).toBe(2);
    expect(result.destroy).toHaveBeenCalled();
  });

  it("accepts exactly the byte limit, counting bytes rather than characters", async () => {
    const result = await safeFetch("https://example.test", {
      dns: publicDns, transport: async () => response("é"), maxBytes: 2,
    });
    expect(result.body.length).toBe(2);
  });

  it.each(["DNS", "response headers", "body"])("terminates a stalled response during %s", async (stage) => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => {});
    const result = response();
    result.body = { [Symbol.asyncIterator]: () => ({ next: never }) };
    let signal: AbortSignal | undefined;
    const transport: Transport = async (request) => {
      signal = request.signal;
      return stage === "response headers" ? never() : result;
    };
    const pending = safeFetch("https://example.test", {
      dns: stage === "DNS" ? never : publicDns, transport, timeoutMs: 20,
    });
    const assertion = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    if (stage !== "DNS") expect(signal?.aborted).toBe(true);
    if (stage === "body") expect(result.destroy).toHaveBeenCalled();
  });

  it("cleans up a transport that returns after the deadline", async () => {
    vi.useFakeTimers();
    const result = response();
    let finish!: (value: TransportResponse) => void;
    const pending = safeFetch("https://example.test", {
      dns: publicDns, transport: () => new Promise((resolve) => { finish = resolve; }), timeoutMs: 10,
    });
    const assertion = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    finish(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(result.destroy).toHaveBeenCalled();
  });

  it("rejects compression so decoded bytes cannot bypass the cap", async () => {
    const result = response();
    result.headers["content-encoding"] = "gzip";
    await expect(safeFetch("https://example.test", { dns: publicDns, transport: async () => result })).rejects.toThrow("Encoded");
    expect(result.destroy).toHaveBeenCalled();
  });

  it("uses one deadline across redirects", async () => {
    vi.useFakeTimers();
    const transport: Transport = async () => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return response("", 302, "/again");
    };
    const pending = safeFetch("https://example.test", { dns: publicDns, transport, timeoutMs: 10 });
    const assertion = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    await vi.advanceTimersByTimeAsync(5);
  });

  it("propagates body errors and closes the response", async () => {
    const result = response();
    result.body = (async function* () { throw new Error("broken stream"); })();
    await expect(safeFetch("https://example.test", { dns: publicDns, transport: async () => result })).rejects.toThrow("broken stream");
    expect(result.destroy).toHaveBeenCalled();
  });

  it("rejects invalid limits before transport", async () => {
    for (const options of [{ maxBytes: -1 }, { timeoutMs: 0 }, { maxRedirects: 1.5 }]) {
      await expect(safeFetch("https://example.test", options)).rejects.toThrow("Invalid");
    }
  });
});
