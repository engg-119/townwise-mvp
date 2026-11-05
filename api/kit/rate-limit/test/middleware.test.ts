import { createServer as createHttpServer } from 'node:http';

import { configSchema as serverSchema, createLogger, createServer, loadEnv, type Logger } from '@ckeith26/server-core';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { afterEach, expect, it, vi } from 'vitest';

import { ipKey, rateLimit, RateLimiterUnavailableError, type RateLimiter } from '../src/index.ts';

const config = loadEnv(serverSchema, { NODE_ENV: 'test', TRUST_PROXY: 'loopback', LOG_LEVEL: 'silent' });

function limiter(name: string, consume: RateLimiter['consume']): RateLimiter {
  return { name, consume, reset: () => Promise.resolve() };
}

function serve(mw: RequestHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const router = Router();
  router.get('/', (_req, res) => { res.status(200).json({ ok: true }); });
  const app = createServer({
    config,
    logger: createLogger(config),
    routes: [{ path: '/ok', router }],
    middleware: [mw],
  }).app;
  const server = createHttpServer(app);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}/ok`,
        close: () => new Promise((done, fail) => {
          server.close((err) => { if (err) fail(err); else done(); });
        }),
      });
    });
  });
}

async function hit(mw: RequestHandler): Promise<globalThis.Response> {
  const running = await serve(mw);
  try {
    return await fetch(running.url);
  } finally {
    await running.close();
  }
}

afterEach(() => { vi.useRealTimers(); });

it('middleware: deny gives 429 rate_limited with Retry-After and retryAfterSeconds; store-down with \'allow\' calls next; with \'deny\' gives 503 unavailable; key returning undefined skips limiting', async () => {
  const logger = createLogger(config);

  const allowedConsume = vi.fn<RateLimiter['consume']>(() => Promise.resolve({ allowed: true, remaining: 3, retryAfterSeconds: 0 }));
  const allowed = await hit(rateLimit({ limiter: limiter('test:ok', allowedConsume), key: ipKey, whenStoreDown: 'allow', logger }));
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ ok: true });
  expect(allowedConsume).toHaveBeenCalledWith('ip:127.0.0.1');

  const denied = await hit(rateLimit({
    limiter: limiter('test:deny', () => Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 7 })),
    key: ipKey,
    whenStoreDown: 'deny',
    logger,
  }));
  expect(denied.status).toBe(429);
  expect(denied.headers.get('retry-after')).toBe('7');
  expect(await denied.json()).toEqual({
    error: 'rate_limited',
    message: 'Too many requests. Try again later.',
    retryAfterSeconds: 7,
  });

  const storeAllowed = await hit(rateLimit({
    limiter: limiter('test:down-allow', () => Promise.reject(new RateLimiterUnavailableError('down'))),
    key: ipKey,
    whenStoreDown: 'allow',
    logger,
  }));
  expect(storeAllowed.status).toBe(200);
  expect(await storeAllowed.json()).toEqual({ ok: true });

  const storeDenied = await hit(rateLimit({
    limiter: limiter('test:down-deny', () => Promise.reject(new RateLimiterUnavailableError('down'))),
    key: ipKey,
    whenStoreDown: 'deny',
    logger,
  }));
  expect(storeDenied.status).toBe(503);
  expect(await storeDenied.json()).toEqual({ error: 'unavailable', message: 'Service temporarily unavailable' });

  const skippedConsume = vi.fn<RateLimiter['consume']>();
  const skipped = await hit(rateLimit({
    limiter: limiter('test:skip', skippedConsume),
    key: () => undefined,
    whenStoreDown: 'deny',
    logger,
  }));
  expect(skipped.status).toBe(200);
  expect(await skipped.json()).toEqual({ ok: true });
  expect(skippedConsume).not.toHaveBeenCalled();
});

it('middleware: store-down with allow logs at most one warning per minute per limiter', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = createLogger({ LOG_LEVEL: 'warn' }, {
    destination: { write: (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>); } },
  });
  const next = vi.fn();
  const handler = (name: string): RequestHandler => rateLimit({
    limiter: limiter(name, () => Promise.reject(new RateLimiterUnavailableError('down'))),
    key: () => 'k',
    whenStoreDown: 'allow',
    logger,
  });
  const a = handler('test:a');
  const b = handler('test:b');
  const req = {} as Request;
  const res = {} as Response;
  for (let i = 0; i < 100; i += 1) {
    await a(req, res, next);
    await b(req, res, next);
  }
  vi.setSystemTime(59_999);
  await a(req, res, next);
  const warns = (name: string): number => lines.filter((entry) => entry.level === 40 && entry.limiter === name).length;
  expect(next).toHaveBeenCalledTimes(201);
  expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
  expect(warns('test:a')).toBe(1);
  expect(warns('test:b')).toBe(1);
  vi.setSystemTime(60_000);
  await a(req, res, next);
  expect(warns('test:a')).toBe(2);
  expect(warns('test:b')).toBe(1);
});
