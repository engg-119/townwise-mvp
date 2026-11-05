import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger as PinoLogger, DestinationStream } from 'pino';
import pino from 'pino';

import type { ServerConfig } from './config.ts';

const REDACT_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'mfaToken',
  'recoveryCode',
  'secret',
  'authorization',
  'cookie',
] as const;

/** pino redact paths. A product that needs more edits this list in its copy. */
export const REDACT_PATHS: readonly string[] = REDACT_KEYS.flatMap((key) => [key, `*.${key}`]);

/** Query keys whose values are replaced. A product that needs more edits this list in its copy. */
export const REDACTED_QUERY_KEYS: readonly string[] = [
  't',
  'q',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'state',
  'password',
  'secret',
  'key',
  'signature',
  'sig',
];

export interface SerializedError {
  type: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: SerializedError;
  errors?: SerializedError[];
}

const CAUSE_DEPTH = 3;
const AGGREGATE_LIMIT = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const QUERY_RE = new RegExp(
  `([?&](?:${[...REDACTED_QUERY_KEYS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?:(?:\\[|%5B)[^&=]*)?=)[^&]+`,
  'gi',
);

export function redactUrl(url: string): string {
  QUERY_RE.lastIndex = 0;
  return url.replace(QUERY_RE, '$1[REDACTED]');
}

function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function safeMessage(err: Error): string {
  const fields = record(err);
  if (fields.code === 11000) {
    return err.message.replace(/ dup key: \{[\s\S]*\}$/, ' dup key: [REDACTED]');
  }
  if (err.name === 'ValidationError' && isPlainObject(fields.errors)) {
    const prefix = typeof fields._message === 'string' ? fields._message : err.message;
    return `${prefix}: ${Object.keys(fields.errors).join(', ')}`;
  }
  if (err.name === 'CastError') {
    const kind = typeof fields.kind === 'string' ? fields.kind : 'value';
    const path = typeof fields.path === 'string' ? fields.path : '';
    return `Cast to ${kind} failed at path "${path}"`;
  }
  if (typeof fields.type === 'string' && fields.type.startsWith('entity.')) return fields.type;
  if (err instanceof SyntaxError && err.message.includes('JSON')) return 'invalid JSON (message withheld)';
  return err.message;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stackOf(err: Error, message: string): string {
  const frames = (err.stack ?? '').split('\n').filter((line) => line.startsWith('    at '));
  const head = `${err.name}: ${message}`;
  return frames.length > 0 ? `${head}\n${frames.join('\n')}` : head;
}

function serializeError(value: unknown, depth: number): SerializedError {
  if (!(value instanceof Error)) {
    return { type: typeof value, message: '[non-Error value withheld]' };
  }
  const message = safeMessage(value);
  const serialized: SerializedError = {
    type: value.name,
    message,
    stack: stackOf(value, message),
  };
  const code = record(value).code;
  if (typeof code === 'string' || typeof code === 'number') serialized.code = code;
  if (depth >= CAUSE_DEPTH) return serialized;
  if (value.cause !== undefined) serialized.cause = serializeError(value.cause, depth + 1);
  if (value instanceof AggregateError) {
    serialized.errors = value.errors.slice(0, AGGREGATE_LIMIT).map((entry) => serializeError(entry, depth + 1));
  }
  return serialized;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export const serializers = {
  req(req: IncomingMessage): { id: unknown; method: string | undefined; url: string; ip: string | undefined; userAgent: string | undefined } {
    const extra = req as IncomingMessage & { originalUrl?: string; ip?: string };
    return {
      id: extra.id,
      method: extra.method,
      url: redactUrl(extra.originalUrl ?? extra.url ?? ''),
      ip: extra.ip,
      userAgent: headerValue(extra, 'user-agent'),
    };
  },
  res(res: ServerResponse): { statusCode: number } {
    return { statusCode: res.statusCode };
  },
  err(err: unknown): SerializedError {
    return serializeError(err, 0);
  },
};

export type Logger = PinoLogger;

export function createLogger(
  config: Pick<ServerConfig, 'LOG_LEVEL'>,
  options?: { destination?: DestinationStream },
): Logger {
  const loggerOptions = {
    level: config.LOG_LEVEL,
    serializers: { err: (value: unknown) => serializers.err(value) },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  };
  if (options?.destination !== undefined) return pino(loggerOptions, options.destination);
  return pino(loggerOptions);
}
