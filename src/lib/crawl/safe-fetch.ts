import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { assertPublicAddress, parsePublicUrl } from "./url-policy";

export interface DnsAddress { address: string; family: number }
export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}
export interface PinnedRequest { url: URL; address: DnsAddress; signal: AbortSignal }
export type Transport = (request: PinnedRequest) => Promise<TransportResponse>;
export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  dns?: (hostname: string) => Promise<DnsAddress[]>;
  transport?: Transport;
}

export const nodeTransport: Transport = ({ url, address, signal }) => new Promise((resolve, reject) => {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const originalHost = url.hostname.replace(/^\[|\]$/g, "");
  // Connect directly to the validated IP: no second DNS lookup or pooled socket.
  const req = request({
    protocol: url.protocol,
    hostname: address.address,
    family: address.family,
    port: url.protocol === "https:" ? 443 : 80,
    servername: isIP(originalHost) ? "" : originalHost,
    headers: { Host: url.host, "Accept-Encoding": "identity" },
    path: url.pathname + url.search,
    method: "GET",
    agent: false,
    signal,
    maxHeaderSize: 16 * 1024,
  }, (response) => resolve({
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: response,
    destroy: () => response.destroy(),
  }));
  req.on("error", reject);
  req.end();
});

export interface SafeFetchResult {
  url: string;
  status: number;
  headers: TransportResponse["headers"];
  body: Buffer;
  redirects: number;
}

// This boundary handles destination safety only. The crawler must separately
// enforce robots.txt, approved origins, and its total request/page budget.
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const { maxBytes = 1024 * 1024, timeoutMs = 10_000, maxRedirects = 5,
    dns = (hostname) => lookup(hostname, { all: true, verbatim: true }),
    transport = nodeTransport } = options;
  for (const [name, value] of Object.entries({ maxBytes, timeoutMs, maxRedirects })) {
    if (!Number.isSafeInteger(value) || value < (name === "timeoutMs" ? 1 : 0)) {
      throw new Error(`Invalid ${name} limit.`);
    }
  }
  let url = parsePublicUrl(input);
  const controller = new AbortController();
  let activeResponse: TransportResponse | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Fetch deadline exceeded."));
      controller.abort();
      activeResponse?.destroy();
    }, timeoutMs);
  });
  const work = async (): Promise<SafeFetchResult> => {
    for (let redirects = 0; ; redirects++) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const literalFamily = isIP(host);
      const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await dns(host);
      if (controller.signal.aborted) throw new Error("Fetch deadline exceeded.");
      if (addresses.length === 0) throw new Error("DNS returned no addresses.");
      for (const address of addresses) {
        if (assertPublicAddress(address.address) !== address.family) throw new Error("DNS address family mismatch.");
      }
      // Prefer IPv4: many home networks list IPv6 first but cannot connect over it (seen 2026-10-12).
      const chosen = addresses.find(address => address.family === 4) ?? addresses[0];
      activeResponse = await transport({ url, address: { ...chosen }, signal: controller.signal });
      if (controller.signal.aborted) {
        activeResponse.destroy();
        throw new Error("Fetch deadline exceeded.");
      }
      const response = activeResponse;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.destroy();
        const location = response.headers.location;
        if (typeof location !== "string") throw new Error("Redirect requires a single Location header.");
        if (redirects >= maxRedirects) throw new Error("Redirect limit exceeded.");
        url = parsePublicUrl(new URL(location, url));
        continue;
      }
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") throw new Error("Encoded response bodies are unsupported.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        if (controller.signal.aborted) throw new Error("Fetch deadline exceeded.");
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error("Response body exceeds byte limit.");
        chunks.push(Buffer.from(chunk));
      }
      return { url: url.href, status: response.status, headers: response.headers,
        body: Buffer.concat(chunks, size), redirects };
    }
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    activeResponse?.destroy();
  }
}
