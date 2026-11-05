import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';

import cors from 'cors';
import express, { type Express, type RequestHandler, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { ConfigError, type ServerConfig } from './config.ts';
import { errorHandler, notFound } from './errors.ts';
import { createShutdownController } from './lifecycle.ts';
import type { Logger } from './logger.ts';
import { serializers } from './logger.ts';
import { corsOptions, csrfGuard, parseOrigins } from './origins.ts';
import { parseTrustProxy } from './trustProxy.ts';

export interface ShutdownHook {
  readonly name: string;
  close(): Promise<void>;
}

export interface RouteMount {
  readonly path: `/${string}`;
  readonly router: Router;
}

export interface ServerOptions {
  readonly config: ServerConfig;
  readonly logger: Logger;
  /** Mounted in order. A path that is a segment prefix of a later path throws ConfigError. */
  readonly routes: readonly RouteMount[];
  /** Runs after CSRF and CORS, before routes (for example the global rate limit). */
  readonly middleware?: readonly RequestHandler[];
  /** Run in array order after the HTTP drain, each bounded to 2s. */
  readonly onShutdown?: readonly ShutdownHook[];
  readonly exit?: (code: number) => void;
}

export interface KitServer {
  readonly app: Express;
  /** Listens on config.PORT, applies timeouts, installs signal and exception handlers once. */
  listen(): Promise<{ port: number }>;
  /** Idempotent. Drains, runs hooks, then calls exit(exitCode). */
  shutdown(reason: string, exitCode?: number): Promise<void>;
}

const httpServers = new WeakMap<KitServer, () => Server | undefined>();

/** Test seam. Not part of the public entry. */
export function httpServerOf(kit: KitServer): Server | undefined {
  return httpServers.get(kit)?.();
}

function isSegmentPrefix(earlier: string, later: string): boolean {
  return earlier === later || earlier === '/' || later.startsWith(`${earlier}/`);
}

function assertRouteOrder(routes: readonly RouteMount[]): void {
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const earlier = routes[i]?.path ?? '';
      const later = routes[j]?.path ?? '';
      if (isSegmentPrefix(earlier, later)) {
        throw new ConfigError(
          'routes',
          `'${earlier}' is mounted before '${later}' and would see its requests first; list more specific paths first`,
        );
      }
    }
  }
}

function isHealthz(req: { method?: string | undefined; url?: string | undefined }): boolean {
  if (req.method !== 'GET') return false;
  const path = (req.url ?? '').split('?')[0];
  return path === '/healthz';
}

export function createServer(options: ServerOptions): KitServer {
  const { config, logger } = options;
  const allowed = parseOrigins(config.CORS_ORIGINS, config.NODE_ENV);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(config.TRUST_PROXY));
  app.set('query parser', 'simple');

  app.use(pinoHttp({
    logger,
    genReqId: (_req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    quietReqLogger: true,
    wrapSerializers: false,
    serializers,
    autoLogging: { ignore: (req) => isHealthz(req) },
    customLogLevel: (_req, res, err) => (err !== undefined || res.statusCode >= 500 ? 'error' : 'info'),
  }));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: false,
    strictTransportSecurity: config.NODE_ENV === 'production'
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
  }));

  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(csrfGuard(allowed));
  app.use(cors(corsOptions(allowed)));

  for (const middleware of options.middleware ?? []) app.use(middleware);

  assertRouteOrder(options.routes);
  for (const route of options.routes) app.use(route.path, route.router);

  app.use(notFound);
  app.use(errorHandler);

  let httpServer: Server | undefined;
  let listenPromise: Promise<{ port: number }> | undefined;
  const controller = createShutdownController({
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    logger,
    hooks: options.onShutdown ?? [],
    exit: options.exit ?? ((code: number): void => { process.exit(code); }),
    getServer: () => httpServer,
  });

  const kit: KitServer = {
    app,
    listen(): Promise<{ port: number }> {
      if (listenPromise !== undefined) return listenPromise;
      listenPromise = new Promise((resolve, reject) => {
        const server = createHttpServer(app);
        httpServer = server;
        server.keepAliveTimeout = config.HTTP_KEEP_ALIVE_TIMEOUT_MS;
        server.headersTimeout = server.keepAliveTimeout + 1000;
        const onError = (err: Error): void => { reject(err); };
        server.once('error', onError);
        server.listen(config.PORT, () => {
          server.removeListener('error', onError);
          controller.installProcessHandlers();
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('HTTP server is not bound to a TCP port'));
            return;
          }
          resolve({ port: address.port });
        });
      });
      return listenPromise;
    },
    shutdown(reason: string, exitCode?: number): Promise<void> {
      return exitCode === undefined ? controller.shutdown(reason) : controller.shutdown(reason, exitCode);
    },
  };

  httpServers.set(kit, () => httpServer);
  return kit;
}
