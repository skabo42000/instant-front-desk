import "server-only";
import { isIP } from "node:net";

export function parsePublicUrl(input: string | URL): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }
  if (url.username || url.password) throw new Error("URL credentials are forbidden.");
  // URL normalizes explicit default ports to an empty string.
  if (url.port) throw new Error("Nonstandard ports are forbidden.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) assertPublicAddress(host);
  url.hash = "";
  return url;
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(ipv4Number(base) / size);
}

function ipv6Number(address: string): bigint {
  let normalized = address;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const v4 = ipv4Number(normalized.slice(lastColon + 1));
    normalized = `${normalized.slice(0, lastColon)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [left, right] = normalized.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
  return groups.reduce((value, group) => value * BigInt(65536) + BigInt(parseInt(group, 16)), BigInt(0));
}

function inV6Range(value: bigint, base: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === ipv6Number(base) >> shift;
}

export function assertPublicAddress(address: string): 4 | 6 {
  const family = isIP(address);
  if (family === 4) {
    const blocked: [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
    ];
    if (!blocked.some(([base, bits]) => inV4Range(ipv4Number(address), base, bits))) return 4;
  } else if (family === 6 && !address.includes("%")) {
    const value = ipv6Number(address);
    // Allow global unicast only. Reject mapped/translation/transition addresses,
    // special-purpose 2001::/23, and documentation ranges conservatively.
    if (inV6Range(value, "2000::", 3) &&
        !inV6Range(value, "2001::", 23) &&
        !inV6Range(value, "2001:db8::", 32) &&
        !inV6Range(value, "2002::", 16) &&
        !inV6Range(value, "3fff::", 20)) return 6;
  }
  throw new Error("Address is not public Internet unicast.");
}
