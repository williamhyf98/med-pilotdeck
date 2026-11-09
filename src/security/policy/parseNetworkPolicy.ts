import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { policyIds, policyList, policyRecord } from "./schema.js";

export type NetworkRule = Readonly<{
  id: string;
  enabled: boolean;
  host?: string;
  cidr?: string;
  port: number;
  protocol: "http" | "https" | "ws" | "wss" | "tcp";
  purpose: string;
}>;

export type NetworkPolicy = Readonly<{
  version: 1;
  mode: "deny";
  rules: readonly NetworkRule[];
}>;

const PRIVATE_IPV4: readonly [number, number][] = [
  [0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16], [0x7f000000, 8], [0xa9fe0000, 16],
];

function ipv4Number(address: string): number {
  if (isIP(address) !== 4) throw new Error("Invalid IPv4 address.");
  return address.split(".").reduce((acc, octet) => (acc * 256 + Number(octet)) >>> 0, 0);
}

function privateIPv4(address: number): boolean {
  return PRIVATE_IPV4.some(([base, bits]) => (address >>> (32 - bits)) === (base >>> (32 - bits)));
}

function parseHost(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 253) {
    throw new Error("Network host must be a non-empty hostname or internal IP.");
  }
  if (isIP(value) === 4) {
    if (!privateIPv4(ipv4Number(value))) throw new Error("Public IP addresses cannot be added to the intranet policy.");
    return value;
  }
  if (isIP(value) === 6) {
    if (value !== "::1") throw new Error("IPv6 network rules are not supported in version 1 (except ::1).");
    return value;
  }
  const ascii = domainToASCII(value);
  if (!ascii || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u.test(ascii)
    || ascii.split(".").some((part) => part.startsWith("-") || part.endsWith("-") || part.length > 63)
    || /^[0-9.]+$/u.test(ascii) || value.includes("*") || value.includes(":")) {
    throw new Error("Invalid network hostname.");
  }
  return ascii.toLowerCase();
}

function parseCidr(value: unknown): string {
  if (typeof value !== "string") throw new Error("Network CIDR must be a string.");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/u.exec(value);
  if (!match) throw new Error("Only private IPv4 CIDRs are supported in version 1.");
  const address = ipv4Number(match[1]!);
  const bits = Number(match[2]);
  if (bits < 16 || bits > 32 || !privateIPv4(address)) {
    throw new Error("Network CIDR must be a narrow private IPv4 range (/16 or smaller).");
  }
  const hostMask = (2 ** (32 - bits)) - 1;
  if ((address & hostMask) !== 0 || !privateIPv4((address + hostMask) >>> 0)) {
    throw new Error("Network CIDR must be aligned and entirely private.");
  }
  return value;
}

export function parseNetworkPolicy(value: unknown): NetworkPolicy {
  if (value === undefined) return { version: 1, mode: "deny", rules: [] };
  const record = policyRecord(value, "networkPolicy", ["version", "mode", "rules"]);
  if (record.version !== 1 || record.mode !== "deny") {
    throw new Error("networkPolicy requires version 1 and mode deny.");
  }
  const seen = new Set<string>();
  const rules = policyList(record.rules, "networkPolicy.rules").map((raw, index): NetworkRule => {
    const path = `networkPolicy.rules[${index}]`;
    const entry = policyRecord(raw, path, ["id", "enabled", "host", "cidr", "port", "protocol", "purpose"]);
    const [id] = policyIds([entry.id], `${path}.id`);
    if (seen.has(id!)) throw new Error(`${path}.id must be unique.`);
    seen.add(id!);
    if (typeof entry.enabled !== "boolean" || !Number.isSafeInteger(entry.port)
      || (entry.port as number) < 1 || (entry.port as number) > 65535
      || !["http", "https", "ws", "wss", "tcp"].includes(entry.protocol as string)
      || typeof entry.purpose !== "string" || !entry.purpose.trim() || entry.purpose.length > 200) {
      throw new Error(`${path} contains invalid network rule fields.`);
    }
    if ((entry.host === undefined) === (entry.cidr === undefined)) {
      throw new Error(`${path} must specify exactly one of host or cidr.`);
    }
    return {
      id: id!, enabled: entry.enabled, ...(entry.host !== undefined ? { host: parseHost(entry.host) } : { cidr: parseCidr(entry.cidr) }),
      port: entry.port as number, protocol: entry.protocol as NetworkRule["protocol"],
      purpose: entry.purpose,
    };
  });
  return { version: 1, mode: "deny", rules };
}
