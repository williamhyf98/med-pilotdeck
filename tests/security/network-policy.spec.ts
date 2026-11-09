import assert from "node:assert/strict";
import test from "node:test";
import { parseNetworkPolicy } from "../../src/security/policy/parseNetworkPolicy.js";

test("missing network policy denies all traffic", () => {
  assert.deepEqual(parseNetworkPolicy(undefined), { version: 1, mode: "deny", rules: [] });
});

test("network policy accepts scoped internal hosts and private IPv4 CIDRs", () => {
  const result = parseNetworkPolicy({
    version: 1, mode: "deny", rules: [
      { id: "hospital.pacs", enabled: true, host: "pacs.internal", port: 8443, protocol: "https", purpose: "PACS" },
      { id: "hospital.subnet", enabled: false, cidr: "10.2.4.0/24", port: 8000, protocol: "http", purpose: "Imaging" },
      { id: "hospital.localhost", enabled: true, host: "pacs", port: 80, protocol: "http", purpose: "Local PACS" },
    ],
  });
  assert.equal(result.rules.length, 3);
});

test("network rules reject wildcard, public IP, broad CIDR and invalid addresses", () => {
  const base = { id: "hospital.pacs", enabled: true, port: 8443, protocol: "https", purpose: "PACS" };
  for (const location of [
    { host: "" }, { host: "*" }, { host: "8.8.8.8" }, { host: "https://pacs.internal" },
    { host: "bad_host" }, { cidr: "0.0.0.0/0" }, { cidr: "10.0.0.0/8" },
    { cidr: "10.2.4.1/24" }, { cidr: "8.8.8.0/24" }, { cidr: "10.1.2.0/33" },
    { cidr: "::/0" }, { host: "pacs.internal", cidr: "10.1.2.0/24" },
  ]) {
    assert.throws(() => parseNetworkPolicy({
      version: 1, mode: "deny", rules: [{ ...base, ...location }],
    }), /network|CIDR|host|IPv[46]|Public IP/i, JSON.stringify(location));
  }
});

test("network policy rejects invalid ports, unknown fields, duplicate IDs and non-deny mode", () => {
  const rule = { id: "hospital.pacs", enabled: true, host: "pacs.internal", port: 8443, protocol: "https", purpose: "PACS" };
  for (const port of [0, -1, 65536, 443.5, "443"]) {
    assert.throws(() => parseNetworkPolicy({ version: 1, mode: "deny", rules: [{ ...rule, port }] }));
  }
  assert.throws(() => parseNetworkPolicy({ version: 1, mode: "allow", rules: [] }));
  assert.throws(() => parseNetworkPolicy({ version: 1, mode: "deny", rules: [{ ...rule, executable: "curl" }] }));
  assert.throws(() => parseNetworkPolicy({ version: 1, mode: "deny", rules: [rule, rule] }));
});
