import { randomUUID } from 'node:crypto';

import express from 'express';
import { afterEach, expect, test } from 'vitest';

import type { RouteMount } from '../src/index.ts';
import { badRequestSentinel, dupKeySentinel, startServer, type Started } from './helpers/server.ts';

const EVIL = 'https://evil.example';
const ALLOWED = 'http://localhost:8081';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK = /^(::ffff:)?127\.0\.0\.1$/;

let current: Started | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.kit.shutdown('afterEach', 0);
    current = undefined;
  }
});

async function boot(opts?: Parameters<typeof startServer>[0]): Promise<Started> {
  current = await startServer(opts);
  return current;
}

async function read(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function jsonOf(text: string): unknown {
  return JSON.parse(text) as unknown;
}

test('helmet headers, form-action \'none\' and no-store are present on 200, 404 and 500', async () => {
  const started = await boot();
  const expected = ["default-src 'none'", "form-action 'none'", "frame-ancestors 'none'"].sort();
  for (const path of ['/t/ok', '/nope', '/t/boom']) {
    const response = await read(`${started.base}${path}`);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp.split(';').map((part) => part.trim()).filter((part) => part !== '').sort()).toEqual(expected);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('strict-transport-security')).toBeNull();
  }
  const prod = await startServer({ config: { NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' } });
  try {
    const response = await read(`${prod.base}/t/ok`);
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  } finally {
    await prod.kit.shutdown('prod', 0);
  }
});

test('no Cross-Origin-Opener-Policy header', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/ok`);
  expect(response.headers.get('cross-origin-opener-policy')).toBeNull();
});

test('CSRF: cross-origin POST is 403 before CORS and the body is never parsed or echoed', async () => {
  const started = await boot();
  const sentinel = `SENT${randomUUID()}`;
  const response = await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: { Origin: EVIL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: sentinel }),
  });
  expect(response.status).toBe(403);
  expect(jsonOf(response.text)).toEqual({ error: 'origin_not_allowed', message: 'Origin not allowed' });
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(response.text).not.toContain(sentinel);
  expect(started.hits).toEqual([]);
});

test('CSRF: POST with Origin: null is 403', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: { Origin: 'null', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(403);
  expect(jsonOf(response.text)).toEqual({ error: 'origin_not_allowed', message: 'Origin not allowed' });
});

test('CSRF: POST without Origin is allowed', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  expect(response.status).toBe(200);
  expect(jsonOf(response.text)).toEqual({ method: 'POST', body: { a: 1 } });
});

test('CSRF: cross-origin PUT, PATCH and DELETE are 403 before CORS', async () => {
  const started = await boot();
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const response = await read(`${started.base}/t/echo`, {
      method,
      headers: { Origin: EVIL, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(jsonOf(response.text)).toEqual({ error: 'origin_not_allowed', message: 'Origin not allowed' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }
  expect(started.hits).toEqual([]);
});

test('CORS: allowed origin gets ACAO plus credentials; disallowed preflight gets no ACAO', async () => {
  const started = await boot();
  const allowed = await read(`${started.base}/t/ok`, { headers: { Origin: ALLOWED } });
  expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
  const expose = allowed.headers.get('access-control-expose-headers') ?? '';
  expect(expose).toContain('X-Request-Id');
  expect(expose).toContain('Retry-After');
  const preflight = await read(`${started.base}/t/echo`, {
    method: 'OPTIONS',
    headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST' },
  });
  expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
});

test('CORS: a preflight requesting authorization and content-type gets both in Access-Control-Allow-Headers, and the list names nothing else', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/echo`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-requested-with',
    },
  });
  const allow = (response.headers.get('access-control-allow-headers') ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
    .sort();
  expect(allow).toEqual(['authorization', 'content-type']);
});

test('request id: every response carries a generated X-Request-Id, and an inbound X-Request-Id is not used', async () => {
  const started = await boot();
  const first = await read(`${started.base}/t/ok`, { headers: { 'X-Request-Id': 'client-chosen-id' } });
  const second = await read(`${started.base}/nope`, { headers: { 'X-Request-Id': 'client-chosen-id' } });
  const firstId = first.headers.get('x-request-id') ?? '';
  const secondId = second.headers.get('x-request-id') ?? '';
  expect(firstId).toMatch(UUID_V4);
  expect(secondId).toMatch(UUID_V4);
  expect(firstId).not.toBe(secondId);
  expect(firstId).not.toBe('client-chosen-id');
  expect(secondId).not.toBe('client-chosen-id');
  const logged = started.logs.lines().filter((line) => {
    const req = line.req;
    return typeof req === 'object' && req !== null && (req as { id?: unknown }).id === firstId;
  });
  expect(logged.length).toBeGreaterThan(0);
});

test('raw route: with /webhooks (express.text) listed before / (express.json), a JSON-typed POST to /webhooks reaches the raw router as the untouched string', async () => {
  const raw = express.Router();
  raw.use(express.text({ type: '*/*' }));
  raw.post('/', (req, res) => {
    res.status(200).json({ type: typeof req.body, body: req.body as unknown });
  });
  const json = express.Router();
  json.use(express.json());
  const routes: RouteMount[] = [
    { path: '/webhooks', router: raw },
    { path: '/', router: json },
  ];
  const started = await boot({ routes });
  const response = await read(`${started.base}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"a": 1}',
  });
  expect(response.status).toBe(200);
  expect(jsonOf(response.text)).toEqual({ type: 'string', body: '{"a": 1}' });
});

test('body limits: a router\'s own express.json limit applies (no global parser overrides it)', async () => {
  const started = await boot();
  const big = await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonBytes(2048),
  });
  expect(big.status).toBe(413);
  expect(jsonOf(big.text)).toEqual({ error: 'payload_too_large', message: 'Payload Too Large' });
  const small = await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonBytes(900),
  });
  expect(small.status).toBe(200);
});

test('errors: a malformed JSON body gives 400 malformed_json, and neither the response nor any log line contains body text', async () => {
  const started = await boot();
  const sentinel = `SENT${randomUUID()}`;
  const response = await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{"password": ${sentinel}`,
  });
  expect(response.status).toBe(400);
  expect(jsonOf(response.text)).toEqual({ error: 'malformed_json', message: 'Request body is not valid JSON.' });
  expect(response.text).not.toContain(sentinel);
  expect(started.logs.text()).not.toContain(sentinel);
  expect(started.logs.lines().some((line) => line.errType === 'entity.parse.failed')).toBe(true);
});

test('errors: a non-AppError with status 400 and a detailed message is answered with Bad Request', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/bad400`);
  expect(response.status).toBe(400);
  expect(jsonOf(response.text)).toEqual({ error: 'bad_request', message: 'Bad Request' });
  expect(response.text).not.toContain('detailed');
  expect(response.text).not.toContain(badRequestSentinel);
});

test('errors: AppError with retryAfterSeconds sets Retry-After and the body field', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/retry`);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('30');
  expect(jsonOf(response.text)).toEqual({ error: 'rate_limited', message: 'Too many requests', retryAfterSeconds: 30 });
});

test('errors: async handler rejection gives a 500 JSON body with no stack', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/reject`);
  expect(response.status).toBe(500);
  expect(response.headers.get('content-type') ?? '').toMatch(/^application\/json/);
  expect(jsonOf(response.text)).toEqual({ error: 'internal', message: 'Internal server error' });
  expect(response.text).not.toContain('at ');
});

test('errors: a 500 caused by a duplicate-key error logs no key value', async () => {
  const started = await boot();
  const response = await read(`${started.base}/t/dup`);
  expect(response.status).toBe(500);
  expect(jsonOf(response.text)).toEqual({ error: 'internal', message: 'Internal server error' });
  expect(started.logs.text()).not.toContain(dupKeySentinel);
  const line = started.logs.lines().find((entry) => {
    const err = entry.err;
    return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      && (err as { message: string }).message.endsWith('dup key: [REDACTED]');
  });
  expect(line).toBeDefined();
  expect(line).toHaveProperty('url');
});

test('logs: no line contains the authorization or cookie header, or the body', async () => {
  const started = await boot();
  const auth = `SENT${randomUUID()}`;
  const body = `SENT${randomUUID()}`;
  const cookie = `SENT${randomUUID()}`;
  await read(`${started.base}/t/echo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth}`,
      Cookie: `__Host-access=${cookie}`,
    },
    body: JSON.stringify({ secret: body }),
  });
  await read(`${started.base}/t/boom`);
  await read(`${started.base}/healthz`);
  const text = started.logs.text();
  expect(text).not.toContain(auth);
  expect(text).not.toContain(body);
  expect(text).not.toContain(cookie);
  const access = started.logs.lines().filter((line) => line.req !== undefined && line.res !== undefined);
  expect(access.length).toBeGreaterThan(0);
  for (const line of access) {
    expect(Object.keys(line.req as object)).toEqual(['id', 'method', 'url', 'ip', 'userAgent']);
    expect((line.req as { url?: string }).url).not.toBe('/healthz');
  }
});

test('client ip: X-Forwarded-For 6.6.6.6, 203.0.113.7 from loopback with TRUST_PROXY=loopback resolves to 203.0.113.7', async () => {
  const started = await boot();
  expect(await clientIp(started, { 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' })).toBe('203.0.113.7');
});

test('client ip: with TRUST_PROXY=loopback,104.16.0.0/13, X-Forwarded-For 203.0.113.7, 104.16.0.1 resolves to 203.0.113.7', async () => {
  const started = await boot({ config: { TRUST_PROXY: 'loopback,104.16.0.0/13' } });
  expect(await clientIp(started, { 'X-Forwarded-For': '203.0.113.7, 104.16.0.1' })).toBe('203.0.113.7');
});

test('client ip: an IPv6 client in X-Forwarded-For resolves to that address', async () => {
  const started = await boot();
  expect(await clientIp(started, { 'X-Forwarded-For': '2001:db8::1' })).toBe('2001:db8::1');
});

test('client ip: no X-Forwarded-For yields the socket peer', async () => {
  const started = await boot();
  expect(await clientIp(started)).toMatch(LOOPBACK);
});

test('client ip: with TRUST_PROXY=10.0.0.0/8 (the peer is not trusted), X-Forwarded-For is ignored and req.ip is the socket address', async () => {
  const started = await boot({ config: { TRUST_PROXY: '10.0.0.0/8' } });
  expect(await clientIp(started, { 'X-Forwarded-For': '203.0.113.7' })).toMatch(LOOPBACK);
});

function jsonBytes(size: number): string {
  const wrapper = '{"k":""}';
  return `{"k":"${'a'.repeat(size - wrapper.length)}"}`;
}

async function clientIp(started: Started, headers?: Record<string, string>): Promise<string> {
  const response = await read(`${started.base}/t/ip`, headers === undefined ? undefined : { headers });
  expect(response.status).toBe(200);
  const body = jsonOf(response.text) as { ip: string };
  return body.ip;
}
