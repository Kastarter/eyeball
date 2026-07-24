import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  type AddressResolver,
  createGuardedLookup,
  createSsrfSafeWebhookFetch,
  isBlockedAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  WebhookSsrfError,
} from "../src/webhooks/ssrf.js";

/**
 * SEC-002 regression suite. Every test is socket-free: the guard classifies
 * and pins at the injected-resolver boundary, so a blocked (or rebound) address
 * is rejected before any TCP connection is attempted. No test binds or dials a
 * port, matching the sandbox's no-loopback constraint.
 */

function resolverFor(addresses: readonly LookupAddress[]): AddressResolver {
  return () => Promise.resolve(addresses);
}

const v4 = (address: string): LookupAddress => ({ address, family: 4 });
const v6 = (address: string): LookupAddress => ({ address, family: 6 });

function runLookup(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  all = false,
): Promise<{ error: NodeJS.ErrnoException | null; address: unknown }> {
  return new Promise((resolve) => {
    lookup(
      hostname,
      { all, family: 0 },
      (error: NodeJS.ErrnoException | null, address: unknown) => {
        resolve({ error, address });
      },
    );
  });
}

describe("IPv4 address classification", () => {
  it("blocks every private, loopback, link-local, CGNAT, and multicast range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIpv4(address)).toBe(true);
    }
  });

  it("permits ordinary public addresses, including near-boundary values", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.169.0.1",
      "223.255.255.255",
    ]) {
      expect(isBlockedIpv4(address)).toBe(false);
    }
  });

  it("blocks IANA special-purpose ranges that are not uniformly reachable", () => {
    for (const address of [
      "192.0.0.1", // 192.0.0.0/24 protocol assignments
      "192.0.2.5", // TEST-NET-1
      "192.88.99.1", // 6to4 relay anycast (deprecated)
      "198.18.0.1", // benchmark 198.18/15
      "198.19.255.254", // benchmark 198.18/15 (upper half)
      "198.51.100.7", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
      "240.0.0.1", // reserved class E
    ]) {
      expect(isBlockedIpv4(address)).toBe(true);
    }
  });

  it("does not over-block neighbours of the special-purpose ranges", () => {
    for (const address of [
      "192.0.1.1", // just outside 192.0.0/24 and TEST-NET-1
      "192.1.0.1", // 192.1/16 is ordinary unicast
      "192.89.0.1", // adjacent to 192.88.99/24
      "198.17.255.254", // just below 198.18/15
      "198.20.0.1", // just above 198.18/15
      "198.51.99.1", // adjacent to TEST-NET-2
      "203.0.114.1", // adjacent to TEST-NET-3
    ]) {
      expect(isBlockedIpv4(address)).toBe(false);
    }
  });
});

describe("IPv6 address classification", () => {
  it("blocks loopback, unspecified, unique-local, link-local, and multicast", () => {
    for (const address of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "[::1]",
      "fe80::1%eth0",
    ]) {
      expect(isBlockedIpv6(address)).toBe(true);
    }
  });

  it("classifies IPv4-mapped IPv6 by the embedded IPv4 value", () => {
    expect(isBlockedIpv6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("permits ordinary global unicast addresses", () => {
    expect(isBlockedIpv6("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIpv6("2001:4860:4860::8888")).toBe(false);
  });

  it("classifies by bytes, so non-canonical spellings cannot evade the guard", () => {
    // Every legal spelling of loopback must classify identically to ::1.
    for (const address of [
      "0:0:0:0:0:0:0:1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "0:0:0::1",
      "::0.0.0.1", // IPv4-compatible form of ::1
    ]) {
      expect(isBlockedIpv6(address)).toBe(true);
    }
    // Uppercase, bracketed, and mixed-case mapped forms too.
    expect(isBlockedIpv6("::FFFF:169.254.169.254")).toBe(true);
    expect(isBlockedIpv6("[::ffff:10.0.0.1]")).toBe(true);
  });

  it("classifies NAT64 well-known 64:ff9b::/96 by its embedded IPv4", () => {
    expect(isBlockedIpv6("64:ff9b::169.254.169.254")).toBe(true);
    expect(isBlockedIpv6("64:ff9b::10.0.0.1")).toBe(true);
    expect(isBlockedIpv6("64:ff9b::7f00:1")).toBe(true); // 127.0.0.1
    expect(isBlockedIpv6("64:ff9b::8.8.8.8")).toBe(false);
  });

  it("blocks NAT64 local-use 64:ff9b:1::/48 outright (operator-local translator)", () => {
    expect(isBlockedIpv6("64:ff9b:1::1")).toBe(true);
    expect(isBlockedIpv6("64:ff9b:1:0:0:0:8.8.8.8")).toBe(true);
  });

  it("classifies 6to4 2002::/16 by its embedded IPv4", () => {
    expect(isBlockedIpv6("2002:0a00:0001::")).toBe(true); // 10.0.0.1
    expect(isBlockedIpv6("2002:7f00:0001::")).toBe(true); // 127.0.0.1
    expect(isBlockedIpv6("2002:0808:0808::")).toBe(false); // 8.8.8.8
  });

  it("classifies Teredo 2001:0000::/32 by its (de-obfuscated) client IPv4", () => {
    // Client IPv4 is the last 32 bits XOR 0xffffffff; 0xf5fffffe → 10.0.0.1.
    expect(isBlockedIpv6("2001::f5ff:fffe")).toBe(true);
    // 0x80fffffe → 127.0.0.1.
    expect(isBlockedIpv6("2001::80ff:fffe")).toBe(true);
  });
});

describe("isBlockedAddress fails closed", () => {
  it("blocks anything that is not a recognizable IP literal", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("999.999.999.999")).toBe(true);
  });

  it("delegates recognizable literals to the version classifier", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("::1")).toBe(true);
  });
});

describe("createGuardedLookup", () => {
  it("pins to the resolved public address when every address is permitted", async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([v4("93.184.216.34")]),
    });
    const { error, address } = await runLookup(lookup, "example.test");
    expect(error).toBeNull();
    expect(address).toBe("93.184.216.34");
  });

  it("rejects when the host resolves to a private address (rebinding at connect time)", async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([v4("10.0.0.5")]),
    });
    const { error } = await runLookup(lookup, "rebinding.test");
    expect(error).toBeInstanceOf(WebhookSsrfError);
  });

  it("rejects a split-horizon answer that mixes a public and a private address", async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([v4("93.184.216.34"), v4("127.0.0.1")]),
    });
    const { error } = await runLookup(lookup, "split.test");
    expect(error).toBeInstanceOf(WebhookSsrfError);
  });

  it("rejects a resolver answer whose stated family contradicts the address", async () => {
    // Public address, so the only reason to reject is the family mismatch
    // (stated IPv6 for a real IPv4 literal), not the blocked-address check.
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([{ address: "93.184.216.34", family: 6 }]),
    });
    const { error } = await runLookup(lookup, "spoofed-family.test");
    expect(error).toBeInstanceOf(WebhookSsrfError);
  });

  it("fails closed when resolution returns no addresses", async () => {
    const lookup = createGuardedLookup({ resolveAll: resolverFor([]) });
    const { error } = await runLookup(lookup, "empty.test");
    expect(error).toBeInstanceOf(WebhookSsrfError);
  });

  it("propagates the underlying resolver error without opening a socket", async () => {
    const boom = new Error("ENOTFOUND");
    const lookup = createGuardedLookup({
      resolveAll: () => Promise.reject(boom),
    });
    const { error } = await runLookup(lookup, "broken.test");
    expect(error).toBe(boom);
  });

  it("returns every vetted address when the caller requests all", async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([v4("93.184.216.34"), v6("2606:4700::1")]),
    });
    const { error, address } = await runLookup(lookup, "multi.test", true);
    expect(error).toBeNull();
    expect(address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
  });

  it("honours the allowPrivateNetwork escape hatch for dev targets", async () => {
    const lookup = createGuardedLookup({
      allowPrivateNetwork: true,
      resolveAll: resolverFor([v4("127.0.0.1")]),
    });
    const { error, address } = await runLookup(lookup, "dev.test");
    expect(error).toBeNull();
    expect(address).toBe("127.0.0.1");
  });
});

describe("createSsrfSafeWebhookFetch", () => {
  it("rejects delivery to a host that rebinds to a private address before any connection", async () => {
    const fetchImpl = createSsrfSafeWebhookFetch({
      resolveAll: resolverFor([v4("169.254.169.254")]),
    });
    await expect(
      fetchImpl("https://cloud-metadata.test/steal", { method: "POST" }),
    ).rejects.toBeInstanceOf(WebhookSsrfError);
  });

  it("rejects an IPv4-mapped IPv6 rebinding to loopback", async () => {
    const fetchImpl = createSsrfSafeWebhookFetch({
      resolveAll: resolverFor([v6("::ffff:127.0.0.1")]),
    });
    await expect(
      fetchImpl("https://mapped.test/hook", { method: "POST", body: "x" }),
    ).rejects.toBeInstanceOf(WebhookSsrfError);
  });

  it("rejects a literal private IPv4 target that would bypass the guarded lookup", async () => {
    // Resolver yields a public address; the rejection can only come from the
    // literal-IP preflight, since Node dials literal hosts without `lookup`.
    const fetchImpl = createSsrfSafeWebhookFetch({
      resolveAll: resolverFor([v4("93.184.216.34")]),
    });
    await expect(
      fetchImpl("https://127.0.0.1/hook", { method: "POST" }),
    ).rejects.toBeInstanceOf(WebhookSsrfError);
  });

  it("rejects a literal private IPv6 target that would bypass the guarded lookup", async () => {
    const fetchImpl = createSsrfSafeWebhookFetch({
      resolveAll: resolverFor([v4("93.184.216.34")]),
    });
    await expect(
      fetchImpl("https://[::1]/hook", { method: "POST" }),
    ).rejects.toBeInstanceOf(WebhookSsrfError);
  });

  it("rejects non-HTTPS targets by default", async () => {
    const fetchImpl = createSsrfSafeWebhookFetch({
      resolveAll: resolverFor([v4("93.184.216.34")]),
    });
    await expect(
      fetchImpl("http://plaintext.test/hook"),
    ).rejects.toBeInstanceOf(WebhookSsrfError);
  });

  it("still fails closed on a public host when the resolver yields nothing", async () => {
    const fetchImpl = createSsrfSafeWebhookFetch({
      resolveAll: resolverFor([]),
    });
    await expect(fetchImpl("https://public.test/hook")).rejects.toBeInstanceOf(
      WebhookSsrfError,
    );
  });
});
