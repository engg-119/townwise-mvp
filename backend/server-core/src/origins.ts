import type { CorsOptions } from 'cors';
import type { RequestHandler } from 'express';

import type { ServerConfig } from './config.ts';
import { ConfigError } from './config.ts';
import { AppError } from './errors.ts';

function badOrigin(entry: string, nodeEnv: ServerConfig['NODE_ENV']): boolean {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return true;
  }
  if (url.origin !== entry) return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return nodeEnv === 'production' && url.protocol !== 'https:';
}

/** The validated origin set used by the CSRF guard and CORS. */
export function parseOrigins(raw: string, nodeEnv: ServerConfig['NODE_ENV']): ReadonlySet<string> {
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const allowed = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    if (badOrigin(entry, nodeEnv)) {
      throw new ConfigError('CORS_ORIGINS', `entry ${String(index + 1)} is not an http(s) origin`);
    }
    allowed.add(entry);
  }
  return allowed;
}

const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfGuard(allowed: ReadonlySet<string>): RequestHandler {
  return (req, _res, next) => {
    if (!MUTATING.has(req.method)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      next(new AppError(403, 'origin_not_allowed', 'Origin not allowed'));
      return;
    }
    next();
  };
}

export function corsOptions(allowed: ReadonlySet<string>): CorsOptions {
  return {
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowed.has(origin));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  };
}
