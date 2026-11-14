// The guarded calendar fetcher (src/calendar/fetch.ts). Nothing here reaches the network: requests go as plain HTTP to
// a server on 127.0.0.1 through an injected transport, and only the injected lookup answers the .test names. Only the
// success, redirect, size and timeout cases use a policy that lets 127.0.0.1 through; every blocked-address case uses
// the real policy.
import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_ACCEPT, CALENDAR_FETCH_TIMEOUT_MS, CALENDAR_USER_AGENT, createCalendarFetcher, isBlockedAddress,
  MAX_CALENDAR_BYTES, MAX_REDIRECTS, type CalendarFetcherDeps,
} from '../src/calendar/fetch.ts';

const CALENDAR = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const HOST = 'calendar.test';
const LOOPBACK: readonly LookupAddress[] = [{ address: '127.0.0.1', family: 4 }];
// Public addresses the real policy allows. The transport never connects to them: it sends everything to 127.0.0.1.
const PUBLIC_V4 = '93.184.215.14';
const PUBLIC_V6 = '2606:4700:4700::1111';

const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const server = createServer((req, res) => {
  const url = req.url ?? '';
  seen.push({ url, headers: req.headers });
  const path = new URL(url, 'http://local.test').pathname;
  const redirect = (location: string): void => { res.writeHead(302, { Location: location }).end(); };
  const hops = /^\/hops\/(\d+)$/.exec(path);
  if (hops !== null) {
    const left = Number(hops[1]);
    if (left === 0) res.writeHead(200).end(CALENDAR);
    else redirect(`/hops/${String(left - 1)}`);
    return;
  }
  switch (path) {
    case '/cal.ics': res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(CALENDAR); return;
    case '/relative': redirect('cal.ics'); return;
    case '/cookie': res.writeHead(302, { Location: '/cal.ics', 'Set-Cookie': 'session=sentinel' }).end(); return;
    case '/no-location': res.writeHead(302).end(); return;
    case '/not-modified': res.writeHead(304).end(); return;
    case '/missing': res.writeHead(404).end('not here'); return;
    case '/error': res.writeHead(500).end('broken'); return;
    case '/to-loopback': redirect('https://127.0.0.1/cal.ics'); return;
    case '/to-metadata': redirect('https://169.254.169.254/metadata/identity/oauth2/token'); return;
    case '/to-private-name': redirect('https://private.test/cal.ics'); return;
    case '/to-http': redirect(`http://${HOST}/cal.ics`); return;
    case '/to-port': redirect(`https://${HOST}:8443/cal.ics`); return;
    case '/to-user': redirect(`https://owner:secret@${HOST}/cal.ics`); return;
    case '/exact': res.writeHead(200).end(Buffer.alloc(MAX_CALENDAR_BYTES, 'a')); return;
    case '/big': {
      // Chunked, so no Content-Length warns the reader.
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.end(Buffer.alloc(MAX_CALENDAR_BYTES + 1, 'a'));
      return;
    }
    case '/big-declared': res.writeHead(200, { 'Content-Length': String(2 * MAX_CALENDAR_BYTES) }).write('BEGIN:VCALENDAR'); return;
    case '/hang': return;
    case '/slow-body': res.writeHead(200).write('BEGIN:VCALENDAR'); return;
    default: res.writeHead(404).end();
  }
});
let port = 0;

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  seen.length = 0;
});

/** Lets 127.0.0.1, and nothing else the real policy blocks, through. */
const allowLoopback = (address: string): boolean => address !== '127.0.0.1' && isBlockedAddress(address);

function lookupFrom(names: Readonly<Record<string, readonly LookupAddress[]>>) {
  return vi.fn((hostname: string): Promise<readonly LookupAddress[]> => {
    const found = names[hostname];
    return found === undefined ? Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })) : Promise.resolve(found);
  });
}

const loopbackLookup: LookupFunction = (_hostname, options, callback) => {
  if (options.all === true) callback(null, [...LOOPBACK]);
  else callback(null, '127.0.0.1', 4);
};

/**
 * Plain HTTP to the local server: what the fetcher asked for, with the server's port. `pinned` keeps the fetcher's own
 * lookup, so the connection goes where it pointed (127.0.0.1 under allowLoopback); otherwise the transport points the
 * connection at 127.0.0.1 itself, for a fetch whose judged address is a public one.
 */
function localTransport(sent: RequestOptions[], pinned: boolean, toPort = (): number => port): NonNullable<CalendarFetcherDeps['request']> {
  return (options, onResponse) => {
    sent.push(options);
    return httpRequest({ ...options, port: toPort(), ...(pinned ? {} : { lookup: loopbackLookup }) }, onResponse);
  };
}

/** `calendar.test` resolves to 127.0.0.1 and the policy lets it through. */
function localFetcher(sent: RequestOptions[] = [], deps: CalendarFetcherDeps = {}) {
  return createCalendarFetcher({
    lookup: lookupFrom({ [HOST]: LOOPBACK }), request: localTransport(sent, true), isBlocked: allowLoopback, timeoutMs: 2000, ...deps,
  });
}

/** The real policy; the names resolve as given. */
function guardedFetcher(names: Readonly<Record<string, readonly LookupAddress[]>>, sent: RequestOptions[] = []) {
  const lookup = lookupFrom(names);
  return { lookup, fetcher: createCalendarFetcher({ lookup, request: localTransport(sent, false), timeoutMs: 2000 }) };
}

/** What the lookup the fetcher handed the transport answers, asked for one address and for all of them. */
function pinnedAnswers(options: RequestOptions | undefined): { one: unknown; all: unknown } {
  const lookup = options?.lookup;
  if (lookup === undefined) throw new Error('the request had no lookup');
  const answers: { one: unknown; all: unknown } = { one: undefined, all: undefined };
  lookup('elsewhere.test', {}, (err, address, family) => { answers.one = { err, address, family }; });
  lookup('elsewhere.test', { all: true }, (err, addresses) => { answers.all = { err, addresses }; });
  return answers;
}

const ok = (host = HOST) => ({ ok: true, text: CALENDAR, host });
const failed = (code: string) => ({ ok: false, code });

describe('the address policy', () => {
  it('blocks each IPv4 range from its first address to its last, and lets its neighbours through', () => {
    const ranges: [first: string, last: string, outside: string[]][] = [
      ['0.0.0.0', '0.255.255.255', ['1.0.0.0']],
      ['10.0.0.0', '10.255.255.255', ['9.255.255.255', '11.0.0.0']],
      ['100.64.0.0', '100.127.255.255', ['100.63.255.255', '100.128.0.0']],
      ['127.0.0.0', '127.255.255.255', ['126.255.255.255', '128.0.0.0']],
      ['169.254.0.0', '169.254.255.255', ['169.253.255.255', '169.255.0.0']],
      ['172.16.0.0', '172.31.255.255', ['172.15.255.255', '172.32.0.0']],
      ['192.0.0.0', '192.0.0.255', ['191.255.255.255', '192.0.1.0']],
      ['192.0.2.0', '192.0.2.255', ['192.0.1.255', '192.0.3.0']],
      ['192.168.0.0', '192.168.255.255', ['192.167.255.255', '192.169.0.0']],
      ['198.18.0.0', '198.19.255.255', ['198.17.255.255', '198.20.0.0']],
      ['198.51.100.0', '198.51.100.255', ['198.51.99.255', '198.51.101.0']],
      ['203.0.113.0', '203.0.113.255', ['203.0.112.255', '203.0.114.0']],
      ['224.0.0.0', '239.255.255.255', ['223.255.255.255']],
      ['240.0.0.0', '255.255.255.255', []],
    ];
    for (const [first, last, outside] of ranges) {
      expect(isBlockedAddress(first), first).toBe(true);
      expect(isBlockedAddress(last), last).toBe(true);
      for (const address of outside) expect(isBlockedAddress(address), address).toBe(false);
    }
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    for (const address of ['8.8.8.8', '1.1.1.1', PUBLIC_V4, '142.250.80.46']) expect(isBlockedAddress(address), address).toBe(false);
  });

  it('blocks IPv6 unspecified, loopback, unique local, link-local, multicast, documentation, Teredo and 6to4', () => {
    const ranges: [first: string, last: string][] = [
      ['::', '::'],
      ['::1', '::1'],
      ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['3fff::', '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ];
    for (const [first, last] of ranges) {
      expect(isBlockedAddress(first), first).toBe(true);
      expect(isBlockedAddress(last), last).toBe(true);
    }
    expect(isBlockedAddress('FE80::1')).toBe(true);
    for (const address of [PUBLIC_V6, '2001:4860:4860::8888', '2001:db7:ffff::1', '2001:db9::1', '2003::1', '3fff:1000::1']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks every other IPv6 address outside global unicast (2000::/3)', () => {
    for (const address of ['::2', '::7f00:1', '::8.8.8.8', '::ffff:0:808:808', '64:ff9b:1::808:808', '100::1', '1fff:ffff::1', '4000::1', 'e000::1', 'fec0::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('judges an IPv4-mapped or NAT64 address by the IPv4 address inside, however it is written', () => {
    for (const address of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::FFFF:10.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
      '::ffff:100.64.0.1', '::ffff:0.0.0.0', '::ffff:255.255.255.255',
      '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b:0:0:0:0:c0a8:101',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::8.8.8.8', '64:ff9b::808:808']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks anything that is not a plain IP address', () => {
    for (const value of ['', HOST, '127.1', '256.0.0.1', '[::1]', ' 8.8.8.8', 'fe80::1%eth0', `${PUBLIC_V6}%1`, '1.2.3.4.5']) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });
});

describe('fetching a calendar link', () => {
  it('keeps the spec’s bounds: 10 seconds, 1 MB and 3 redirects', () => {
    expect(CALENDAR_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(MAX_CALENDAR_BYTES).toBe(1024 * 1024);
    expect(MAX_REDIRECTS).toBe(3);
  });

  it('fetches an https address, connecting only to the address it judged, with the hostname for TLS and Host', async () => {
    const sent: RequestOptions[] = [];
    // calendar.test resolves nowhere but the injected lookup, so reaching the server proves the judged address was used.
    expect(await localFetcher(sent).fetch(`https://${HOST}/cal.ics`)).toEqual(ok());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      hostname: HOST, port: 443, path: '/cal.ics', method: 'GET', agent: false,
      headers: { 'User-Agent': 'Townwise calendar reader', Accept: 'text/calendar, */*;q=0.5' },
    });
    expect(Object.keys(sent[0]?.headers ?? {}).sort()).toEqual(['Accept', 'User-Agent']);
    expect(pinnedAnswers(sent[0])).toEqual({
      one: { err: null, address: '127.0.0.1', family: 4 },
      all: { err: null, addresses: [{ address: '127.0.0.1', family: 4 }] },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).toMatchObject({ host: `${HOST}:${String(port)}`, 'user-agent': CALENDAR_USER_AGENT, accept: CALENDAR_ACCEPT });
    expect(seen[0]?.headers.cookie).toBeUndefined();
  });

  it('fetches a webcal: address as https:, an explicit :443 too, keeping the query and dropping the fragment', async () => {
    const fetcher = localFetcher();
    expect(await fetcher.fetch(`webcal://${HOST}/cal.ics`)).toEqual(ok());
    expect(await fetcher.fetch('WEBCAL://Calendar.TEST/cal.ics')).toEqual(ok());
    expect(await fetcher.fetch(`  https://${HOST}:443/cal.ics?token=abc#week  `)).toEqual(ok());
    expect(seen.map((request) => request.url)).toEqual(['/cal.ics', '/cal.ics', '/cal.ics?token=abc']);
  });

  it('refuses http, another port, a user name or password, another scheme or no URL with bad_link, without a lookup or a connection', async () => {
    const sent: RequestOptions[] = [];
    const lookup = lookupFrom({ [HOST]: LOOPBACK });
    const fetcher = localFetcher(sent, { lookup });
    for (const address of [
      `http://${HOST}/cal.ics`, `https://${HOST}:8443/cal.ics`, `https://${HOST}:80/cal.ics`, `webcal://${HOST}:8080/cal.ics`,
      `https://owner:secret@${HOST}/cal.ics`, `https://owner@${HOST}/cal.ics`, `ftp://${HOST}/cal.ics`, 'file:///etc/passwd',
      `${HOST}/cal.ics`, 'not a link', '',
    ]) {
      expect(await fetcher.fetch(address), address).toEqual(failed('bad_link'));
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('follows a relative redirect, resolving the host again', async () => {
    const lookup = lookupFrom({ [HOST]: LOOPBACK });
    expect(await localFetcher([], { lookup }).fetch(`https://${HOST}/relative`)).toEqual(ok());
    expect(seen.map((request) => request.url)).toEqual(['/relative', '/cal.ics']);
    expect(lookup.mock.calls).toEqual([[HOST], [HOST]]);
  });

  it('follows 3 redirects and answers http_error at a 4th, without following it', async () => {
    const fetcher = localFetcher();
    expect(await fetcher.fetch(`https://${HOST}/hops/3`)).toEqual(ok());
    expect(seen).toHaveLength(4);
    seen.length = 0;
    expect(await fetcher.fetch(`https://${HOST}/hops/4`)).toEqual(failed('http_error'));
    expect(seen.map((request) => request.url)).toEqual(['/hops/4', '/hops/3', '/hops/2', '/hops/1']);
  });

  it('sends no cookie, even one a redirect set', async () => {
    expect(await localFetcher().fetch(`https://${HOST}/cookie`)).toEqual(ok());
    expect(seen).toHaveLength(2);
    expect(seen.map((request) => request.headers.cookie)).toEqual([undefined, undefined]);
  });

  it('answers http_error for a status other than 2xx, or a redirect with no Location', async () => {
    const fetcher = localFetcher();
    for (const path of ['/missing', '/error', '/not-modified', '/no-location']) {
      expect(await fetcher.fetch(`https://${HOST}${path}`), path).toEqual(failed('http_error'));
    }
  });

  it('refuses a redirect to http, another port or a user name with bad_link, without following it', async () => {
    const fetcher = localFetcher();
    for (const path of ['/to-http', '/to-port', '/to-user']) {
      expect(await fetcher.fetch(`https://${HOST}${path}`), path).toEqual(failed('bad_link'));
    }
    expect(seen.map((request) => request.url)).toEqual(['/to-http', '/to-port', '/to-user']);
  });

  it('answers unreachable when the name does not resolve, resolves to nothing, or the connection fails', async () => {
    const sent: RequestOptions[] = [];
    const fetcher = localFetcher(sent, { lookup: lookupFrom({ 'empty.test': [] }) });
    expect(await fetcher.fetch(`https://${HOST}/cal.ics`)).toEqual(failed('unreachable'));
    expect(await fetcher.fetch('https://empty.test/cal.ics')).toEqual(failed('unreachable'));
    expect(sent).toEqual([]);

    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const closedPort = (closed.address() as AddressInfo).port;
    closed.close();
    await once(closed, 'close');
    expect(await localFetcher([], { request: localTransport([], true, () => closedPort) }).fetch(`https://${HOST}/cal.ics`))
      .toEqual(failed('unreachable'));
  });

  it('answers unreachable when the transport throws, and never throws itself', async () => {
    const fetcher = localFetcher([], { request: () => { throw new Error('transport failed'); } });
    expect(await fetcher.fetch(`https://${HOST}/cal.ics`)).toEqual(failed('unreachable'));
  });

  it('reads exactly 1 MB, and answers too_large past it, streamed or declared', async () => {
    const fetcher = localFetcher();
    const exact = await fetcher.fetch(`https://${HOST}/exact`);
    expect(exact.ok && exact.text.length).toBe(MAX_CALENDAR_BYTES);
    expect(await fetcher.fetch(`https://${HOST}/big`)).toEqual(failed('too_large'));
    expect(await fetcher.fetch(`https://${HOST}/big-declared`)).toEqual(failed('too_large'));
  });

  it('times out a server that never answers, a body that never ends, and a lookup that never returns in time', async () => {
    const fetcher = localFetcher([], { timeoutMs: 100 });
    expect(await fetcher.fetch(`https://${HOST}/hang`)).toEqual(failed('timeout'));
    expect(await fetcher.fetch(`https://${HOST}/slow-body`)).toEqual(failed('timeout'));

    // A lookup that answers after the deadline: the fetch has ended, and nothing connects afterwards.
    const sent: RequestOptions[] = [];
    const slowLookup = (): Promise<readonly LookupAddress[]> => new Promise((resolve) => { setTimeout(() => { resolve(LOOPBACK); }, 200); });
    const slow = localFetcher(sent, { lookup: slowLookup, timeoutMs: 50 });
    expect(await slow.fetch(`https://${HOST}/cal.ics`)).toEqual(failed('timeout'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toEqual([]);
  });
});

describe('fetching a blocked address (the real policy)', () => {
  it('refuses an IP literal in a blocked range with blocked_address, making no lookup and no connection', async () => {
    const sent: RequestOptions[] = [];
    const { lookup, fetcher } = guardedFetcher({}, sent);
    for (const address of [
      'https://10.0.0.5/cal.ics', 'https://127.0.0.1/cal.ics', 'https://169.254.169.254/metadata/identity/oauth2/token',
      'https://100.64.0.1/cal.ics', 'https://0.0.0.0/cal.ics', 'https://172.16.0.1/cal.ics', 'https://192.168.1.10/cal.ics',
      'webcal://192.168.1.10/cal.ics', 'https://2130706433/cal.ics', 'https://0x7f.1/cal.ics', 'https://0177.0.0.1/cal.ics',
      'https://[::1]/cal.ics', 'https://[::]/cal.ics', 'https://[fd00::1]/cal.ics', 'https://[fe80::1]/cal.ics',
      'https://[ff02::1]/cal.ics', 'https://[::ffff:127.0.0.1]/cal.ics', 'https://[::ffff:a9fe:a9fe]/cal.ics',
      'https://[64:ff9b::a00:5]/cal.ics', 'https://[2001:db8::1]/cal.ics',
    ]) {
      expect(await fetcher.fetch(address), address).toEqual(failed('blocked_address'));
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('refuses a name that resolves to the metadata endpoint', async () => {
    const sent: RequestOptions[] = [];
    const { fetcher } = guardedFetcher({ 'metadata.test': [{ address: '169.254.169.254', family: 4 }] }, sent);
    expect(await fetcher.fetch('https://metadata.test/cal.ics')).toEqual(failed('blocked_address'));
    expect(sent).toEqual([]);
  });

  it('refuses a name when any one of its addresses is blocked, an IPv4-mapped one included', async () => {
    const sent: RequestOptions[] = [];
    const { fetcher } = guardedFetcher({
      'mixed.test': [{ address: PUBLIC_V4, family: 4 }, { address: '10.0.0.5', family: 4 }],
      'mixed-v6.test': [{ address: PUBLIC_V6, family: 6 }, { address: 'fd00::5', family: 6 }],
      'mapped.test': [{ address: '::ffff:10.0.0.5', family: 6 }],
      'nat64.test': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
      'loopback.test': [{ address: PUBLIC_V4, family: 4 }, { address: '::1', family: 6 }],
    }, sent);
    for (const host of ['mixed.test', 'mixed-v6.test', 'mapped.test', 'nat64.test', 'loopback.test']) {
      expect(await fetcher.fetch(`https://${host}/cal.ics`), host).toEqual(failed('blocked_address'));
    }
    expect(sent).toEqual([]);
  });

  it('connects to a public address it judged, an IPv4 one first', async () => {
    const sent: RequestOptions[] = [];
    const { fetcher } = guardedFetcher({ [HOST]: [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }] }, sent);
    expect(await fetcher.fetch(`https://${HOST}/cal.ics`)).toEqual(ok());
    expect(pinnedAnswers(sent[0])).toEqual({
      one: { err: null, address: PUBLIC_V4, family: 4 },
      all: { err: null, addresses: [{ address: PUBLIC_V4, family: 4 }] },
    });
  });

  it('does not follow a redirect to 127.0.0.1, the metadata endpoint or a name that resolves to a private address', async () => {
    const sent: RequestOptions[] = [];
    const { lookup, fetcher } = guardedFetcher({
      [HOST]: [{ address: PUBLIC_V4, family: 4 }], 'private.test': [{ address: '10.0.0.5', family: 4 }],
    }, sent);
    for (const path of ['/to-loopback', '/to-metadata', '/to-private-name']) {
      expect(await fetcher.fetch(`https://${HOST}${path}`), path).toEqual(failed('blocked_address'));
    }
    // One request each, the redirect; the blocked Location is never requested.
    expect(seen.map((request) => request.url)).toEqual(['/to-loopback', '/to-metadata', '/to-private-name']);
    expect(sent).toHaveLength(3);
    expect(lookup).toHaveBeenCalledWith('private.test');
  });
});
