import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * SSRF egress guard for outbound webhook delivery.
 *
 * Registration-time validation (see `endpoint-store.ts`) rejects literal
 * private targets, but a hostname that resolves publicly at create time can be
 * rebound to a private address before delivery (DNS rebinding). This module
 * resolves the target at connection time, classifies every returned address,
 * and pins the socket to a single vetted address so the connection cannot be
 * re-resolved to a private host between the check and the connect (no TOCTOU).
 * Classification is the single source of truth reused by `endpoint-store.ts`.
 */

/** Raised when a webhook host resolves to a blocked address or cannot be vetted. */
export class WebhookSsrfError extends Error {
  constructor(hostname: string, address?: string) {
    super(
      address === undefined
        ? `Webhook host ${hostname} did not resolve to a permitted address.`
        : `Webhook host ${hostname} resolved to blocked address ${address}.`,
    );
    this.name = "WebhookSsrfError";
  }
}

/** Parse a dotted-quad into four octets, or undefined if it is not one. */
function parseIpv4Octets(
  address: string,
): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return undefined;
    }
    const value = Number(part);
    if (value > 255) {
      return undefined;
    }
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/**
 * True for loopback, private, link-local, CGNAT, multicast, reserved (class E),
 * and IANA special-purpose IPv4 ranges — i.e. anything that must never be a
 * webhook delivery target. The special-purpose ranges (TEST-NET-1/2/3, the
 * `198.18/15` benchmark block, `192.0.0/24` protocol assignments, and the
 * deprecated `192.88.99/24` 6to4 relay anycast) are blocked because they are
 * not uniformly globally reachable and can be routed to internal services.
 * Fails closed: any value that is not a dotted quad is treated as blocked.
 */
export function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (octets === undefined) {
    return true;
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/**
 * Parse an IPv6 textual address — with optional brackets, a zone suffix, `::`
 * compression, or an embedded dotted-IPv4 tail — into its 16 octets, or
 * undefined if it is not a well-formed IPv6 literal. Parsing to bytes makes
 * range classification representation-invariant: every legal spelling of the
 * same address (e.g. `::1` and `0:0:0:0:0:0:0:1`) yields identical bytes.
 */
function ipv6ToBytes(input: string): number[] | undefined {
  let text = input.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  const zone = text.indexOf("%");
  if (zone !== -1) {
    text = text.slice(0, zone);
  }
  if (text.length === 0 || text.includes(":::")) {
    return undefined;
  }
  // Fold an embedded dotted-IPv4 tail into two hextets.
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) {
      return undefined;
    }
    const v4 = parseIpv4Octets(text.slice(lastColon + 1));
    if (v4 === undefined) {
      return undefined;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const parseGroups = (segment: string): number[] | undefined => {
    if (segment === "") {
      return [];
    }
    const groups: number[] = [];
    for (const part of segment.split(":")) {
      if (!/^[0-9a-f]{1,4}$/u.test(part)) {
        return undefined;
      }
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = parseGroups(halves[0] ?? "");
  if (head === undefined) {
    return undefined;
  }
  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) {
      return undefined;
    }
    groups = head;
  } else {
    const tail = parseGroups(halves[1] ?? "");
    if (tail === undefined) {
      return undefined;
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return undefined;
    }
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/**
 * True for loopback, unspecified, unique-local (fc00::/7), link-local
 * (fe80::/10), and multicast (ff00::/8) IPv6 addresses. Addresses that embed an
 * IPv4 destination — IPv4-mapped/compatible, NAT64 well-known (64:ff9b::/96),
 * and 6to4 (2002::/16) — are classified by that embedded IPv4 so a public
 * target stays permitted while a private one is blocked. NAT64 local-use
 * (64:ff9b:1::/48) and Teredo (2001:0000::/32) are handled conservatively.
 * Fails closed on any value that does not parse as an IPv6 literal.
 */
export function isBlockedIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (bytes === undefined) {
    return true;
  }
  const at = (index: number): number => bytes[index] ?? 0;
  const zeroBetween = (start: number, end: number): boolean => {
    for (let index = start; index < end; index += 1) {
      if (at(index) !== 0) {
        return false;
      }
    }
    return true;
  };
  const embeddedIpv4 = (start: number): string =>
    `${at(start)}.${at(start + 1)}.${at(start + 2)}.${at(start + 3)}`;

  if (zeroBetween(0, 16)) {
    return true; // ::
  }
  if (zeroBetween(0, 15) && at(15) === 1) {
    return true; // ::1
  }
  // IPv4-mapped ::ffff:0:0/96 → classify the embedded IPv4.
  if (zeroBetween(0, 10) && at(10) === 0xff && at(11) === 0xff) {
    return isBlockedIpv4(embeddedIpv4(12));
  }
  // IPv4-compatible ::/96 (deprecated) → classify the embedded IPv4.
  if (zeroBetween(0, 12)) {
    return isBlockedIpv4(embeddedIpv4(12));
  }
  // NAT64 64:ff9b::. The well-known /96 (bytes 4-11 zero) carries the target in
  // bytes 12-15; any other use of the prefix (incl. the 64:ff9b:1::/48 local-use
  // translator) is not a path to a legitimate public webhook, so block it.
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) {
    if (zeroBetween(4, 12)) {
      return isBlockedIpv4(embeddedIpv4(12));
    }
    return true;
  }
  // 6to4 2002::/16 → classify the embedded IPv4 (bytes 2-5).
  if (at(0) === 0x20 && at(1) === 0x02) {
    return isBlockedIpv4(embeddedIpv4(2));
  }
  // Teredo 2001:0000::/32 → classify the client IPv4 (last 4 bytes XOR 0xff).
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) {
    const client = `${at(12) ^ 0xff}.${at(13) ^ 0xff}.${at(14) ^ 0xff}.${
      at(15) ^ 0xff
    }`;
    return isBlockedIpv4(client);
  }
  if ((at(0) & 0xfe) === 0xfc) {
    return true; // unique-local fc00::/7
  }
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) {
    return true; // link-local fe80::/10
  }
  if (at(0) === 0xff) {
    return true; // multicast ff00::/8
  }
  return false;
}

/**
 * Classify a bare IP literal. Fails closed: any value that is not a
 * recognizable IPv4 or IPv6 literal is treated as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isBlockedIpv4(address);
  }
  if (version === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

/** Resolve every address for a hostname. Injectable for socket-free tests. */
export type AddressResolver = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

const systemResolveAll: AddressResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
      } else {
        resolve(addresses);
      }
    });
  });

export interface GuardedLookupOptions {
  /** Dev-only escape hatch mirroring the endpoint store's `allowPrivateNetwork`. */
  readonly allowPrivateNetwork?: boolean;
  /** Injectable resolver so tests never touch the network. */
  readonly resolveAll?: AddressResolver;
}

/**
 * Build a `net.LookupFunction` that resolves the host, requires *every*
 * resolved address to be public (unless `allowPrivateNetwork`), and pins the
 * connection to the vetted address. A rebinding response that mixes a public
 * and a private address is rejected. Fails closed on empty resolution.
 */
export function createGuardedLookup(
  options: GuardedLookupOptions = {},
): LookupFunction {
  const resolveAll = options.resolveAll ?? systemResolveAll;
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  return ((hostname, lookupOptions, callback) => {
    const wantsAll =
      typeof lookupOptions === "object" && lookupOptions.all === true;
    resolveAll(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(new WebhookSsrfError(hostname), "", 0);
          return;
        }
        for (const entry of addresses) {
          // A resolver answer whose stated family disagrees with the actual
          // literal (or is unknown) is never legitimate: net.connect would
          // interpret the address under the wrong family. Reject it so the
          // family we pin to the socket is always truthful.
          const family = isIP(entry.address);
          if (family === 0 || family !== entry.family) {
            callback(new WebhookSsrfError(hostname, entry.address), "", 0);
            return;
          }
          if (!allowPrivateNetwork && isBlockedAddress(entry.address)) {
            callback(new WebhookSsrfError(hostname, entry.address), "", 0);
            return;
          }
        }
        if (wantsAll) {
          callback(null, addresses as LookupAddress[]);
          return;
        }
        const pinned = addresses[0];
        if (pinned === undefined) {
          callback(new WebhookSsrfError(hostname), "", 0);
          return;
        }
        callback(null, pinned.address, pinned.family);
      })
      .catch((error: unknown) => {
        callback(
          error instanceof Error
            ? (error as NodeJS.ErrnoException)
            : new WebhookSsrfError(hostname),
          "",
          0,
        );
      });
  }) as LookupFunction;
}

export interface SsrfSafeFetchOptions {
  /** Dev-only escape hatch mirroring the endpoint store's `allowPrivateNetwork`. */
  readonly allowPrivateNetwork?: boolean;
  /** Permit `http:` targets (dev only); production delivery is HTTPS. */
  readonly allowInsecureHttp?: boolean;
  /** Injectable resolver so tests never touch the network. */
  readonly resolveAll?: AddressResolver;
}

function toHeaderRecord(
  headers: RequestInit["headers"],
): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) {
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      record[key] = value;
    }
    return record;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

/**
 * A `fetch`-shaped transport that pins connections to a DNS-vetted address.
 * Uses Node core `https.request({ lookup })` (undici is not importable here),
 * so the guarded lookup owns resolution and the socket cannot be re-resolved
 * to a private host. Reads only the response status, matching the webhook
 * deliverer's contract; the response body is drained and discarded.
 */
export function createSsrfSafeWebhookFetch(
  options: SsrfSafeFetchOptions = {},
): typeof globalThis.fetch {
  const lookup = createGuardedLookup({
    ...(options.allowPrivateNetwork === undefined
      ? {}
      : { allowPrivateNetwork: options.allowPrivateNetwork }),
    ...(options.resolveAll === undefined
      ? {}
      : { resolveAll: options.resolveAll }),
  });
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const guardedFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const isHttps = url.protocol === "https:";
    if (!isHttps && !(allowInsecureHttp && url.protocol === "http:")) {
      return Promise.reject(new WebhookSsrfError(url.hostname));
    }
    // When the host is a literal IP, Node connects it directly without ever
    // calling the guarded `lookup`, so the classifier would be bypassed.
    // Classify the literal here (stripping IPv6 brackets) and fail closed.
    const literalHost = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
    if (
      !allowPrivateNetwork &&
      isIP(literalHost) !== 0 &&
      isBlockedAddress(literalHost)
    ) {
      return Promise.reject(new WebhookSsrfError(url.hostname, literalHost));
    }
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const headers = toHeaderRecord(init?.headers);
    const body = init?.body;
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const request = requestFn(
        url,
        { method: init?.method ?? "GET", headers, lookup, agent: false },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 502;
          resolve(
            new Response(null, {
              status: status >= 200 && status <= 599 ? status : 502,
            }),
          );
        },
      );
      request.on("error", reject);
      if (signal !== null && signal !== undefined) {
        const onAbort = () => {
          request.destroy(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted.", "AbortError"),
          );
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      if (typeof body === "string") {
        request.end(body);
      } else {
        request.end();
      }
    });
  };
  return guardedFetch as typeof globalThis.fetch;
}
