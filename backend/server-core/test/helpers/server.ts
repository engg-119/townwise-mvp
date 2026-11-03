import { randomUUID } from 'node:crypto';

import express, { type Router } from 'express';
import type { DestinationStream } from 'pino';
import { vi, type Mock } from 'vitest';

import { AppError } from '../../src/errors.ts';
import { createLogger, type Logger } from '../../src/logger.ts';
import { createServer, type KitServer, type RouteMount, type ServerOptions, type ShutdownHook } from '../../src/server.ts';
import type { ServerConfig } from '../../src/config.ts';

export const dupKeySentinel = `SENT${randomUUID()}`;
export const badRequestSentinel = `SENT${randomUUID()}`;

export function testConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    LOG_LEVEL: 'info',
    CORS_ORIGINS: 'http://localhost:8081',
    TRUST_PROXY: 'loopback',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: 65000,
    SHUTDOWN_TIMEOUT_MS: 6000,
    ...overrides,
  };
}

export interface CapturedLogs {
  lines(): Record<string, unknown>[];
  text(): string;
}

export function captureLogger(): { logger: Logger; logs: CapturedLogs } {
  const lines: Record<string, unknown>[] = [];
  let text = '';
  const destination: DestinationStream = {
    write(message: string) {
      text += message;
      for (const line of message.split('\n')) {
        if (line.trim() === '') continue;
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
    },
  };
  const logger = createLogger({ LOG_LEVEL: 'info' }, { destination });
  return {
    logger,
    logs: {
      lines: () => lines,
      text: () => text,
    },
  };
}

export function testRouter(hits: string[]): Router {
  const router = express.Router();
  router.use(express.json({ limit: '1kb' }));
  router.get('/slow', (req, res) => {
    hits.push('/slow');
    const raw = req.query.ms;
    const parsed = typeof raw === 'string' ? Number(raw) : 300;
    const ms = Number.isFinite(parsed) ? parsed : 300;
    setTimeout(() => { res.status(200).json({ ok: true }); }, ms);
  });
  router.all('/echo', (req, res) => {
    hits.push('/echo');
    res.status(200).json({ method: req.method, body: req.body as unknown });
  });
  router.get('/ok', (_req, res) => {
    hits.push('/ok');
    res.status(200).json({ ok: true });
  });
  router.get('/boom', () => {
    hits.push('/boom');
    throw new Error('boom');
  });
  router.get('/ip', (req, res) => {
    hits.push('/ip');
    res.status(200).json({ ip: req.ip });
  });
  router.get('/reject', async () => {
    hits.push('/reject');
    await Promise.reject(new Error('rejected'));
  });
  router.get('/dup', () => {
    hits.push('/dup');
    const dup = new Error(
      `E11000 duplicate key error collection: db.users index: email_1 dup key: { email: "${dupKeySentinel}" }`,
    );
    dup.name = 'MongoServerError';
    throw Object.assign(dup, {
      code: 11000,
      keyValue: { email: dupKeySentinel },
      errorResponse: { errmsg: dupKeySentinel },
    });
  });
  router.get('/bad400', () => {
    hits.push('/bad400');
    throw Object.assign(new Error(`detailed ${badRequestSentinel}`), { status: 400 });
  });
  router.get('/retry', () => {
    hits.push('/retry');
    throw new AppError(429, 'rate_limited', 'Too many requests', { retryAfterSeconds: 30 });
  });
  return router;
}

export interface Started {
  kit: KitServer;
  base: string;
  logs: CapturedLogs;
  exit: Mock<(code: number) => void>;
  hits: string[];
}

export async function startServer(opts?: {
  config?: Partial<ServerConfig>;
  routes?: readonly RouteMount[];
  middleware?: NonNullable<ServerOptions['middleware']>;
  onShutdown?: readonly ShutdownHook[];
}): Promise<Started> {
  const hits: string[] = [];
  const { logger, logs } = captureLogger();
  const exit = vi.fn<(code: number) => void>();
  const options: ServerOptions = {
    config: testConfig(opts?.config),
    logger,
    routes: opts?.routes ?? [{ path: '/t', router: testRouter(hits) }],
    exit,
  };
  if (opts?.middleware !== undefined) {
    return listen({ ...options, middleware: opts.middleware, ...(opts.onShutdown !== undefined ? { onShutdown: opts.onShutdown } : {}) }, logs, exit, hits);
  }
  if (opts?.onShutdown !== undefined) {
    return listen({ ...options, onShutdown: opts.onShutdown }, logs, exit, hits);
  }
  return listen(options, logs, exit, hits);
}

async function listen(
  options: ServerOptions,
  logs: CapturedLogs,
  exit: Mock<(code: number) => void>,
  hits: string[],
): Promise<Started> {
  const kit = createServer(options);
  const { port } = await kit.listen();
  return { kit, base: `http://127.0.0.1:${String(port)}`, logs, exit, hits };
}

export async function listenersAddedBy(
  event: 'SIGTERM' | 'unhandledRejection',
  action: () => Promise<unknown>,
): Promise<((...args: unknown[]) => void)[]> {
  const current = (): readonly ((...args: never[]) => void)[] => (
    event === 'SIGTERM' ? process.listeners('SIGTERM') : process.listeners('unhandledRejection')
  );
  const before = new Set<unknown>(current());
  await action();
  return current().filter((listener) => !before.has(listener)) as ((...args: unknown[]) => void)[];
}
