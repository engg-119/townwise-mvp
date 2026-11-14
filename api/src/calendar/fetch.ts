// Fetching an owner's calendar link (openspec change connect-owner-calendar: the calendar-subscription spec, design
// decision 5). The address comes from the owner, and the API's container can reach the VNet, the database's private
// endpoint and the managed-identity endpoint, so the guards against request forgery live here.
// Only `https:` on port 443 with no user name or password is fetched; a `webcal:` address is fetched as `https:`. The
// host is resolved and every address it resolves to is judged (an IP literal is judged as written): if any one is
// blocked, nothing is fetched. The connection then goes only to an address that was judged, through a lookup that
// answers nothing else, so a second DNS answer cannot swap it (DNS rebinding); the hostname stays the TLS server name
// and the Host header. Redirects are followed by hand, at most 3, and each Location, resolved against the address that
// sent it, is checked and judged the same way. The whole fetch, redirects included, has 10 seconds, at most 1 MB of
// body is read, and the request carries no cookies and names itself only as "Townwise calendar reader".
// Failures are codes only. Nothing here logs: the address, host and body leave only as the return value.
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';

import { MAX_ICS_BYTES } from './ics.ts';

/** The whole fetch, from the first lookup to the last byte, redirects included. */
export const CALENDAR_FETCH_TIMEOUT_MS = 10_000;
/** A body over this many bytes is not read further: 1 MB, as for an imported file. */
export const MAX_CALENDAR_BYTES = MAX_ICS_BYTES;
/** Redirects followed after the first request. */
export const MAX_REDIRECTS = 3;
export const CALENDAR_USER_AGENT = 'Townwise calendar reader';
export const CALENDAR_ACCEPT = 'text/calendar, */*;q=0.5';

const HTTPS_PORT = 443;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * `bad_link`: not https, another port, a user name or password, or not a URL. `blocked_address`: the host is, or
 * resolves to, an address never fetched. `unreachable`: no address, or the connection failed. `http_error`: a status
 * other than 2xx, or a redirect without a Location or past the limit.
 */
export type CalendarFetchCode = 'bad_link' | 'blocked_address' | 'unreachable' | 'timeout' | 'too_large' | 'http_error';

/** `host` is the given address's host (after `webcal:` becomes `https:`), never a redirect's. */
export type CalendarFetchResult =
  | { readonly ok: true; readonly text: string; readonly host: string }
  | { readonly ok: false; readonly code: CalendarFetchCode };

export interface CalendarFetcher {
  /** Never throws. */
  fetch(address: string): Promise<CalendarFetchResult>;
}

/** Production's defaults for each are below; tests point the transport at a local server and never touch the network. */
export interface CalendarFetcherDeps {
  /** Every address a hostname resolves to. Absent, the system resolver (dns.lookup with `all`). */
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  /** Sends one request and answers through `onResponse`. Absent, https.request. */
  readonly request?: (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;
  /** True for an address never to be fetched. Absent, isBlockedAddress. */
  readonly isBlocked?: (address: string) => boolean;
  /** Absent, CALENDAR_FETCH_TIMEOUT_MS; tests shorten it. */
  readonly timeoutMs?: number;
}

// IPv4: this network, private, shared (CGNAT), loopback, link-local (the managed-identity endpoint is 169.254.169.254),
// IETF protocol assignments, documentation, benchmarking, multicast, and reserved with broadcast.
const BLOCKED_IPV4_SUBNETS: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv6: unspecified, loopback, unique local, link-local, multicast, documentation (both prefixes), and Teredo and 6to4,
// which wrap other addresses. Anything outside global unicast (2000::/3) is reserved and blocked too, without a list.
// IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses are judged by the IPv4 address inside.
const BLOCKED_IPV6_SUBNETS: readonly (readonly [string, number])[] = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['3fff::', 20],
  ['2001::', 32], ['2002::', 16],
];
const EMBEDDING_IPV4_PREFIXES: ReadonlySet<string> = new Set(['0:0:0:0:0:ffff', '64:ff9b:0:0:0:0']);

const BLOCKED_IPV4 = new BlockList();
for (const [network, bits] of BLOCKED_IPV4_SUBNETS) BLOCKED_IPV4.addSubnet(network, bits, 'ipv4');
const BLOCKED_IPV6 = new BlockList();
for (const [network, bits] of BLOCKED_IPV6_SUBNETS) BLOCKED_IPV6.addSubnet(network, bits, 'ipv6');
/** Not a block list: the one IPv6 range addresses may come from. */
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');

/** An IPv6 address's 8 groups, or null for anything else (an address with a zone id included). */
function ipv6Groups(address: string): number[] | null {
  if (!isIPv6(address) || address.includes('%')) return null;
  // A dotted IPv4 tail becomes the last two groups.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted === null ? address : `${dotted[1] ?? ''}${(Number(dotted[2]) * 256 + Number(dotted[3])).toString(16)}:${
    (Number(dotted[4]) * 256 + Number(dotted[5])).toString(16)}`;
  const [left = '', right] = text.split('::');
  const head = left === '' ? [] : left.split(':');
  const tail = right === undefined || right === '' ? [] : right.split(':');
  return [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail].map((group) => Number.parseInt(group, 16));
}

/**
 * True for an address Townwise never fetches from: one in a blocked range, IPv6 outside global unicast, an IPv4-mapped
 * or NAT64 address whose IPv4 address is blocked, and anything that is not a plain IP address (fails closed).
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return BLOCKED_IPV4.check(address, 'ipv4');
  const groups = ipv6Groups(address);
  if (groups === null) return true;
  const [, , , , , , high = 0, low = 0] = groups;
  if (EMBEDDING_IPV4_PREFIXES.has(groups.slice(0, 6).map((group) => group.toString(16)).join(':'))) {
    return BLOCKED_IPV4.check(`${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`, 'ipv4');
  }
  return BLOCKED_IPV6.check(address, 'ipv6') || !GLOBAL_UNICAST_IPV6.check(address, 'ipv6');
}

/** The address as a URL to fetch (`webcal:` read as `https:`; relative to `base` for a Location), or null for bad_link. */
function linkOf(address: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = new URL(address.trim().replace(/^webcal:/i, 'https:'), base);
  } catch {
    return null;
  }
  // URL drops a default port, so any port here is not 443.
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  return url;
}

/** The URL's hostname without an IPv6 literal's brackets. */
function bareHost(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

interface Pinned { readonly address: string; readonly family: 4 | 6 }

type Answer =
  | { readonly kind: 'body'; readonly text: string }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'failed'; readonly code: CalendarFetchCode };

const TIMEOUT: CalendarFetchResult = { ok: false, code: 'timeout' };

export function createCalendarFetcher(deps: CalendarFetcherDeps = {}): CalendarFetcher {
  const lookup = deps.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true }));
  const request = deps.request ?? ((options: RequestOptions, onResponse: (res: IncomingMessage) => void) => httpsRequest(options, onResponse));
  const isBlocked = deps.isBlocked ?? isBlockedAddress;
  const timeoutMs = deps.timeoutMs ?? CALENDAR_FETCH_TIMEOUT_MS;

  /** The address to connect to, when none of the host's addresses is blocked. An IPv4 one first: they all passed. */
  async function judge(url: URL): Promise<Pinned | 'blocked_address' | 'unreachable'> {
    const hostname = bareHost(url);
    let addresses: readonly LookupAddress[];
    if (isIP(hostname) !== 0) {
      addresses = [{ address: hostname, family: isIP(hostname) }];
    } else {
      try {
        addresses = await lookup(hostname);
      } catch {
        return 'unreachable';
      }
    }
    if (addresses.some(({ address }) => isBlocked(address))) return 'blocked_address';
    const chosen = addresses.find(({ address }) => isIPv4(address)) ?? addresses[0];
    if (chosen === undefined) return 'unreachable';
    return { address: chosen.address, family: isIPv6(chosen.address) ? 6 : 4 };
  }

  /** One GET to `pinned`, the hostname kept for TLS and the Host header. */
  function send(url: URL, pinned: Pinned, signal: AbortSignal): Promise<Answer> {
    return new Promise((resolve) => {
      const failed = (): void => { resolve({ kind: 'failed', code: signal.aborted ? 'timeout' : 'unreachable' }); };
      const tooLarge = (): void => { req.destroy(); resolve({ kind: 'failed', code: 'too_large' }); };
      const req = request({
        hostname: bareHost(url),
        port: HTTPS_PORT,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'User-Agent': CALENDAR_USER_AGENT, Accept: CALENDAR_ACCEPT },
        // A fresh connection per request, so no socket from an earlier address is reused.
        agent: false,
        signal,
        // Answers the judged address whatever is asked, as one address or as a list (autoSelectFamily asks for all).
        lookup: (_hostname, options, callback) => {
          if (options.all === true) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          req.destroy();
          const location = res.headers.location;
          resolve(location === undefined ? { kind: 'failed', code: 'http_error' } : { kind: 'redirect', location });
          return;
        }
        if (status < 200 || status > 299) {
          req.destroy();
          resolve({ kind: 'failed', code: 'http_error' });
          return;
        }
        if (Number(res.headers['content-length']) > MAX_CALENDAR_BYTES) {
          tooLarge();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_CALENDAR_BYTES) tooLarge();
          else chunks.push(chunk);
        });
        res.on('end', () => { resolve({ kind: 'body', text: Buffer.concat(chunks).toString('utf8') }); });
        // Closed before its end (the first answer wins, so a close after the end changes nothing).
        res.on('error', failed);
        res.on('close', failed);
      });
      req.on('error', failed);
      req.end();
    });
  }

  async function follow(address: string, signal: AbortSignal): Promise<CalendarFetchResult> {
    let url = linkOf(address);
    if (url === null) return { ok: false, code: 'bad_link' };
    const host = url.hostname;
    for (let redirects = 0; ; redirects += 1) {
      const pinned = await judge(url);
      if (signal.aborted) return TIMEOUT;
      if (typeof pinned === 'string') return { ok: false, code: pinned };
      const answer = await send(url, pinned, signal);
      if (answer.kind === 'body') return { ok: true, text: answer.text, host };
      if (answer.kind === 'failed') return { ok: false, code: answer.code };
      if (redirects === MAX_REDIRECTS) return { ok: false, code: 'http_error' };
      url = linkOf(answer.location, url);
      if (url === null) return { ok: false, code: 'bad_link' };
    }
  }

  return {
    async fetch(address) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<CalendarFetchResult>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(TIMEOUT); }, timeoutMs);
      });
      try {
        // A transport that throws is unreachable, so the fetch never throws.
        const fetched = follow(address, controller.signal).catch((): CalendarFetchResult => ({ ok: false, code: 'unreachable' }));
        return await Promise.race([fetched, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
