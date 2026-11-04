import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import type { NextFunction } from 'express';
import { z } from 'zod';

import { redactUrl } from './logger.ts';
import type { Logger } from './logger.ts';

export interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, options?: { retryAfterSeconds?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** zod parse; on failure throws AppError(400, 'invalid_request', 'Invalid request') with no field details. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError(400, 'invalid_request', 'Invalid request');
  return parsed.data;
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'not_found', 'Not found'));
};

interface LoggedRequest extends Request {
  log: Logger;
}

function requestLog(req: Request): Logger {
  return (req as LoggedRequest).log;
}

function errorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('type' in err)) return undefined;
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function clientStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as { status?: unknown; statusCode?: unknown };
  const status = typeof record.status === 'number' ? record.status : record.statusCode;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return undefined;
  return status;
}

function phraseOf(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

function codeOf(phrase: string): string {
  return phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function send(res: Response, status: number, body: ErrorBody): void {
  res.status(status).json(body);
}

function errTypeOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next: NextFunction) => {
  const log = requestLog(req);
  if (res.headersSent) {
    log.error({ err, url: redactUrl(req.originalUrl) }, 'request failed');
    next(err);
    return;
  }

  if (err instanceof AppError) {
    const body: { error: string; message: string; retryAfterSeconds?: number } = {
      error: err.code,
      message: err.message,
    };
    if (err.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      body.retryAfterSeconds = err.retryAfterSeconds;
    }
    send(res, err.status, body);
    return;
  }

  const type = errorType(err);
  if (type === 'entity.parse.failed') {
    log.info({ errType: type });
    send(res, 400, { error: 'malformed_json', message: 'Request body is not valid JSON.' });
    return;
  }
  if (type === 'entity.too.large') {
    log.info({ errType: type });
    send(res, 413, { error: 'payload_too_large', message: phraseOf(413) });
    return;
  }
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    log.info({ errType: type });
    send(res, 415, { error: 'unsupported_media_type', message: phraseOf(415) });
    return;
  }

  const status = clientStatus(err);
  if (status !== undefined) {
    const phrase = phraseOf(status);
    log.info({ errType: errTypeOf(err), status });
    send(res, status, { error: codeOf(phrase), message: phrase });
    return;
  }

  log.error({ err, url: redactUrl(req.originalUrl) }, 'request failed');
  send(res, 500, { error: 'internal', message: 'Internal server error' });
};
