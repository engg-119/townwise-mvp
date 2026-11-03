import http from 'node:http';

import { afterEach, expect, test, vi } from 'vitest';

import { createServer, type ShutdownHook } from '../src/index.ts';
import { httpServerOf } from '../src/server.ts';
import { captureLogger, listenersAddedBy, startServer, testConfig, testRouter, type Started } from './helpers/server.ts';

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

interface HttpResult { status: number; body: string; headers: http.IncomingHttpHeaders; endedAt: number }

function httpRequest(url: string, agent?: http.Agent): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
          endedAt: Date.now(),
        });
      });
    });
    request.on('error', reject);
  });
}

async function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error('timed out waiting');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

test('shutdown: an in-flight request on a keep-alive connection completes, and shutdown finishes in under 2s, not keepAliveTimeout', async () => {
  const started = await boot({ config: { HTTP_KEEP_ALIVE_TIMEOUT_MS: 60000, SHUTDOWN_TIMEOUT_MS: 25000 } });
  const agent = new http.Agent({ keepAlive: true });
  try {
    const health = await httpRequest(`${started.base}/healthz`, agent);
    expect(health.status).toBe(200);
    expect(health.body).toBe('{"status":"ok"}');
    const slowPromise = httpRequest(`${started.base}/t/slow`, agent);
    await until(() => started.hits.includes('/slow'));
    const startedAt = Date.now();
    const done = started.kit.shutdown('test', 0);
    const slow = await slowPromise;
    expect(slow.status).toBe(200);
    await done;
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(started.exit).toHaveBeenCalledTimes(1);
    expect(started.exit).toHaveBeenCalledWith(0);
  } finally {
    agent.destroy();
  }
});

test('shutdown: new connections are refused after shutdown starts', async () => {
  const started = await boot();
  const slowPromise = httpRequest(`${started.base}/t/slow?ms=500`);
  await until(() => started.hits.includes('/slow'));
  const done = started.kit.shutdown('test', 0);
  const refused = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const request = http.get(`${started.base}/healthz`, { agent: new http.Agent() }, (response) => {
      response.resume();
      reject(new Error(`expected connection error, got ${String(response.statusCode)}`));
    });
    request.on('error', resolve);
  });
  expect(refused.code).toBe('ECONNREFUSED');
  expect((await slowPromise).status).toBe(200);
  await done;
});

test('shutdown: hooks run in order after drain; a hanging hook is abandoned at 2s', async () => {
  const order: string[] = [];
  let aStarted = 0;
  let hangStarted = 0;
  let cStarted = 0;
  const onShutdown: ShutdownHook[] = [
    { name: 'a', close: () => { order.push('a'); aStarted = Date.now(); return Promise.resolve(); } },
    {
      name: 'hang',
      close: () => {
        order.push('hang');
        hangStarted = Date.now();
        return new Promise<void>(() => {
          // Left pending so the 2s hook timeout abandons this hook.
        });
      },
    },
    { name: 'c', close: () => { order.push('c'); cStarted = Date.now(); return Promise.resolve(); } },
  ];
  const started = await boot({ onShutdown });
  const slowPromise = httpRequest(`${started.base}/t/slow`);
  await until(() => started.hits.includes('/slow'));
  const done = started.kit.shutdown('test', 0);
  const slow = await slowPromise;
  expect(slow.status).toBe(200);
  await done;
  expect(order).toEqual(['a', 'hang', 'c']);
  expect(aStarted).toBeGreaterThanOrEqual(slow.endedAt);
  expect(cStarted - hangStarted).toBeGreaterThanOrEqual(1900);
  expect(started.logs.lines().some((line) => line.hook === 'hang')).toBe(true);
});

test('shutdown: idempotent; second signal is a no-op', async () => {
  const { logger, logs } = captureLogger();
  const exit = vi.fn<(code: number) => void>();
  let closes = 0;
  const hits: string[] = [];
  const kit = createServer({
    config: testConfig(),
    logger,
    routes: [{ path: '/t', router: testRouter(hits) }],
    onShutdown: [{ name: 'h', close: () => { closes += 1; return Promise.resolve(); } }],
    exit,
  });
  const added = await listenersAddedBy('SIGTERM', () => kit.listen());
  const address = httpServerOf(kit)?.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  current = { kit, base: `http://127.0.0.1:${String(port)}`, logs, exit, hits };
  const sigterm = added[0];
  if (sigterm === undefined) throw new Error('SIGTERM listener was not installed');
  sigterm();
  sigterm();
  await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1); });
  expect(exit).toHaveBeenCalledWith(0);
  expect(closes).toBe(1);
  expect(kit.shutdown('x')).toBe(kit.shutdown('y'));
});

test('shutdown: hard timer forces exit', async () => {
  const hooks: ShutdownHook[] = [1, 2, 3, 4].map((n) => ({
    name: `h${String(n)}`,
    close: () => new Promise<void>(() => { /* hang past the hard timer */ }),
  }));
  const started = await boot({ config: { SHUTDOWN_TIMEOUT_MS: 6000 }, onShutdown: hooks });
  const startedAt = Date.now();
  void started.kit.shutdown('test', 0);
  await vi.waitFor(() => { expect(started.exit).toHaveBeenCalled(); }, { timeout: 8000 });
  const elapsed = Date.now() - startedAt;
  expect(started.exit.mock.calls[0]).toEqual([1]);
  expect(elapsed).toBeGreaterThanOrEqual(5900);
  expect(elapsed).toBeLessThan(7000);
  expect(started.logs.lines().some((line) => line.level === 60)).toBe(true);
});

test('listen: keepAliveTimeout equals HTTP_KEEP_ALIVE_TIMEOUT_MS and headersTimeout is larger', async () => {
  const started = await boot({ config: { HTTP_KEEP_ALIVE_TIMEOUT_MS: 65000 } });
  const server = httpServerOf(started.kit);
  expect(server?.keepAliveTimeout).toBe(65000);
  expect(server?.headersTimeout).toBe(66000);
  const agent = new http.Agent({ keepAlive: true });
  try {
    const response = await httpRequest(`${started.base}/healthz`, agent);
    expect(response.headers['keep-alive']).toBe('timeout=65');
  } finally {
    agent.destroy();
  }
});

test('unhandledRejection: a rejection is logged at error and shuts the server down with exit code 1', async () => {
  const { logger, logs } = captureLogger();
  const exit = vi.fn<(code: number) => void>();
  const hits: string[] = [];
  const kit = createServer({
    config: testConfig(),
    logger,
    routes: [{ path: '/t', router: testRouter(hits) }],
    exit,
  });
  const added = await listenersAddedBy('unhandledRejection', () => kit.listen());
  const address = httpServerOf(kit)?.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  current = { kit, base: `http://127.0.0.1:${String(port)}`, logs, exit, hits };
  const listener = added[0];
  if (listener === undefined) throw new Error('unhandledRejection listener was not installed');
  listener(new Error('background'), Promise.resolve());
  await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1); });
  expect(exit).toHaveBeenCalledWith(1);
  expect(logs.lines().some((line) => {
    const err = line.err;
    return line.level === 50 && typeof err === 'object' && err !== null && (err as { message?: unknown }).message === 'background';
  })).toBe(true);
});
