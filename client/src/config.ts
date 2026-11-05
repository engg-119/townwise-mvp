import { z } from 'zod';

z.config({ jitless: true });

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Env {
  EXPO_PUBLIC_API_URL?: string;
  EXPO_PUBLIC_WEB_URL?: string;
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?: string;
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?: string;
}

export interface Config {
  apiUrl: string;
  webUrl: string | null;
  google: { webClientId: string; iosClientId: string | null } | null;
}

const GOOGLE_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

const ENV_KEYS = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_WEB_URL',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
] as const satisfies readonly (keyof Env)[];

function readEnv(value: unknown): Env {
  if (value === null || typeof value !== 'object') throw new ConfigError('configuration input is invalid');
  const record = value as Record<string, unknown>;
  const env: Env = {};
  for (const key of ENV_KEYS) {
    const item = record[key];
    if (item === undefined || item === '') continue;
    if (typeof item !== 'string') throw new ConfigError(`${key} is invalid`);
    env[key] = item;
  }
  return env;
}

function parseHttpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is invalid`);
  }
  if (url.username !== '' || url.password !== '') throw new ConfigError(`${name} must not include userinfo`);
  if (url.search !== '') throw new ConfigError(`${name} must not include a query`);
  if (url.hash !== '') throw new ConfigError(`${name} must not include a fragment`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`${name} must be an http or https URL`);
  return url;
}

function googleId(name: string, value: string): string {
  if (!GOOGLE_ID.test(value)) throw new ConfigError(`${name} is invalid`);
  return value;
}

function build(env: Env, dev: boolean): Config {
  const apiRaw = env.EXPO_PUBLIC_API_URL;
  if (apiRaw === undefined) throw new ConfigError('EXPO_PUBLIC_API_URL is required');
  const apiUrl = apiRaw.replace(/\/+$/, '');
  parseHttpUrl('EXPO_PUBLIC_API_URL', apiUrl);
  if (!dev && apiUrl.startsWith('http:')) throw new ConfigError('EXPO_PUBLIC_API_URL must be https');

  const webRaw = env.EXPO_PUBLIC_WEB_URL;
  let webUrl: string | null = null;
  if (webRaw !== undefined) {
    parseHttpUrl('EXPO_PUBLIC_WEB_URL', webRaw);
    if (new URL(webRaw).origin !== webRaw) throw new ConfigError('EXPO_PUBLIC_WEB_URL must be a bare origin');
    if (!dev && webRaw.startsWith('http:')) throw new ConfigError('EXPO_PUBLIC_WEB_URL must be https');
    webUrl = webRaw;
  }

  const webClientRaw = env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const iosClientRaw = env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const webClientId = webClientRaw === undefined ? null : googleId('EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', webClientRaw);
  const iosClientId = iosClientRaw === undefined ? null : googleId('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID', iosClientRaw);
  if (iosClientId !== null && webClientId === null) {
    throw new ConfigError('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID requires EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID');
  }

  return {
    apiUrl,
    webUrl,
    google: webClientId === null ? null : { webClientId, iosClientId },
  };
}

export const configSchema: z.ZodType<Config, Env> = z.custom<Env>((value): value is Env => value !== null && typeof value === 'object').transform((value) => build(readEnv(value), true));

export function parseConfig(env: Env, opts: { dev: boolean }): Config {
  return build(readEnv(env), opts.dev);
}
