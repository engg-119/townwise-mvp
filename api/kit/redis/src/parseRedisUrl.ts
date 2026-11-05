import { ConfigError } from '@ckeith26/server-core';

export interface RedisUrlParts {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly tls: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

const DB_PATH = /^\/(\d|1[0-5])$/;

function reject(problem: string): never {
  throw new ConfigError('REDIS_URL', problem);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    if (err instanceof URIError) reject('username and password must be percent-encoded');
    throw err;
  }
}

function optionalCredential(value: string): string | undefined {
  const decodedValue = decoded(value);
  return decodedValue === '' ? undefined : decodedValue;
}

function hostOf(hostname: string): string {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === '') reject('hostname is required');
  return host;
}

function portOf(raw: string): number {
  if (raw === '') return 6379;
  if (!/^\d+$/.test(raw)) reject('port must be an integer from 0 to 65535');
  const port = Number(raw);
  if (port > 65535) reject('port must be an integer from 0 to 65535');
  return port;
}

function dbOf(pathname: string): number {
  if (pathname === '' || pathname === '/') return 0;
  const digits = DB_PATH.exec(pathname)?.[1];
  if (digits === undefined) reject('path must be empty, /, or a database number from 0 to 15');
  return Number(digits);
}

/** Turns REDIS_URL into connection fields. The raw URL never reaches ioredis. */
export function parseRedisUrl(url: string, production: boolean): RedisUrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    if (err instanceof TypeError) reject('must be an absolute redis: or rediss: URL');
    throw err;
  }

  const protocol = parsed.protocol;
  if (protocol !== 'redis:' && protocol !== 'rediss:') reject('protocol must be redis: or rediss:');
  if (production && protocol !== 'rediss:') reject('production requires the rediss: protocol');
  if (parsed.search !== '') reject('query string is not allowed');
  if (parsed.hash !== '') reject('fragment is not allowed');

  const host = hostOf(parsed.hostname);
  const port = portOf(parsed.port);
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = optionalCredential(parsed.username);
    password = optionalCredential(parsed.password);
  } catch (err) {
    if (err instanceof URIError) reject('username and password must be percent-encoded');
    throw err;
  }

  return {
    host,
    port,
    db: dbOf(parsed.pathname),
    tls: protocol === 'rediss:',
    username,
    password,
  };
}
