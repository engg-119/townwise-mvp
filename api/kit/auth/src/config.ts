import { createSecretKey, type KeyObject } from 'node:crypto';

import { ConfigError, parseOrigins, type ServerConfig } from '@ckeith26/server-core';
import { z } from 'zod';

const KID = /^[a-z0-9][a-z0-9-]{0,15}$/;
const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export interface KeyringEntry { readonly kid: string; readonly key: KeyObject }

function kidProblem(kid: string, index: number): string {
  if (/^[A-Za-z0-9-]{1,16}$/.test(kid)) return `kid ${kid}`;
  return `position ${String(index + 1)}`;
}

function decodeCanonical(encoded: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) return null;
  return decoded;
}

/** "kid:base64,..."; kid ^[a-z0-9][a-z0-9-]{0,15}$, unique; canonical base64; decoded length within bytes.
 *  Throws Error naming the 1-based position or the kid, never key bytes. */
export function parseKeyring(raw: string, bytes: { readonly min: number; readonly max: number }): KeyringEntry[] {
  const parts = raw.split(',');
  if (raw.trim() === '') throw new Error('position 1');
  const seen = new Set<string>();
  const entries: KeyringEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = (parts[index] ?? '').trim();
    const colon = part.indexOf(':');
    if (colon <= 0) throw new Error(`position ${String(index + 1)}`);
    const kid = part.slice(0, colon);
    const encoded = part.slice(colon + 1);
    if (!KID.test(kid)) throw new Error(kidProblem(kid, index));
    if (seen.has(kid)) throw new Error(`kid ${kid}`);
    seen.add(kid);
    const decoded = decodeCanonical(encoded);
    if (decoded === null || decoded.length < bytes.min || decoded.length > bytes.max) {
      throw new Error(`position ${String(index + 1)}`);
    }
    entries.push({ kid, key: createSecretKey(decoded) });
  }
  return entries;
}

export function isJwtKeyring(raw: string): boolean {
  try {
    parseKeyring(raw, { min: 32, max: 64 });
    return true;
  } catch {
    return false;
  }
}

export function isEncryptionKeyring(raw: string): boolean {
  try {
    parseKeyring(raw, { min: 32, max: 32 });
    return true;
  } catch {
    return false;
  }
}

export function isGoogleClientIdList(raw: string): boolean {
  const parts = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  return parts.length > 0 && parts.every((part) => CLIENT_ID.test(part));
}

export const configSchema = z.object({
  AUTH_ISSUER: z.url().refine((v) => new URL(v).origin === v, 'must be a bare origin'),
  AUTH_JWT_KEYS: z.string().refine(isJwtKeyring,
    'expected kid:base64 entries; kid ^[a-z0-9][a-z0-9-]{0,15}$, unique; each key canonical base64 of 32 to 64 bytes')
    .meta({ secret: true }),
  AUTH_ENCRYPTION_KEYS: z.string().refine(isEncryptionKeyring,
    'expected kid:base64 entries; kid ^[a-z0-9][a-z0-9-]{0,15}$, unique; each key canonical base64 of exactly 32 bytes')
    .meta({ secret: true }),
  AUTH_MAGIC_LINK_URL: z.url().refine((v) => { const u = new URL(v); return u.search === '' && u.hash === ''; },
    'must have no query and no fragment'),
  AUTH_TOTP_ISSUER: z.string().trim().min(1).max(64),
  AUTH_GOOGLE_CLIENT_IDS: z.string().refine(isGoogleClientIdList,
    'expected comma-separated <digits>-<id>.apps.googleusercontent.com').optional(),
});

export type AuthConfig = z.infer<typeof configSchema>;

export interface ResolvedAuthConfig {
  readonly issuer: string;
  readonly secure: boolean;
  readonly jwtKeys: readonly KeyringEntry[];
  readonly encryptionKeys: readonly KeyringEntry[];
  readonly magicLinkUrl: string;
  readonly totpIssuer: string;
  readonly googleClientIds: readonly string[] | null;
  readonly webOrigins: ReadonlySet<string>;
}

type OriginVariable = 'AUTH_ISSUER' | 'AUTH_MAGIC_LINK_URL' | 'CORS_ORIGINS';

function bareOrigin(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== raw) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

function schemeKind(url: URL, production: boolean): 'https' | 'local' | 'bad' {
  if (url.protocol === 'https:') return 'https';
  if (!production && url.protocol === 'http:' && url.hostname === 'localhost') return 'local';
  return 'bad';
}

const SCHEME_PROBLEM = 'must be https, or http://localhost outside production, and every URL must use that same scheme';

function readKeyring(raw: string, variable: string, bytes: { readonly min: number; readonly max: number }): KeyringEntry[] {
  try {
    return parseKeyring(raw, bytes);
  } catch (err) {
    const problem = err instanceof Error ? err.message : 'invalid keyring';
    throw new ConfigError(variable, problem);
  }
}

/** The cross-field checks createAuth runs before anything else. Throws ConfigError. */
export function resolveAuthConfig(
  config: AuthConfig & Pick<ServerConfig, 'NODE_ENV' | 'CORS_ORIGINS'>,
): ResolvedAuthConfig {
  const production = config.NODE_ENV === 'production';
  const issuer = new URL(config.AUTH_ISSUER);
  const magic = new URL(config.AUTH_MAGIC_LINK_URL);
  const checked: { variable: OriginVariable; url: URL }[] = [
    { variable: 'AUTH_ISSUER', url: issuer },
    { variable: 'AUTH_MAGIC_LINK_URL', url: magic },
  ];
  for (const raw of config.CORS_ORIGINS.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
    const url = bareOrigin(raw);
    if (url === null) throw new ConfigError('CORS_ORIGINS', 'must be an http(s) origin');
    checked.push({ variable: 'CORS_ORIGINS', url });
  }

  const kinds = checked.map((entry) => ({ ...entry, kind: schemeKind(entry.url, production) }));
  const bad = kinds.find((entry) => entry.kind === 'bad');
  const first = kinds[0];
  const mixed = bad === undefined && first !== undefined
    ? kinds.find((entry) => entry.kind !== first.kind)
    : undefined;
  const offender = bad ?? mixed;
  if (offender !== undefined) throw new ConfigError(offender.variable, SCHEME_PROBLEM);

  const webOrigins = parseOrigins(config.CORS_ORIGINS, config.NODE_ENV);
  if (webOrigins.size < 1) throw new ConfigError('CORS_ORIGINS', 'must list at least one origin');
  if (!webOrigins.has(magic.origin)) {
    throw new ConfigError('AUTH_MAGIC_LINK_URL', 'origin must be listed in CORS_ORIGINS');
  }

  const jwtKeys = readKeyring(config.AUTH_JWT_KEYS, 'AUTH_JWT_KEYS', { min: 32, max: 64 });
  const encryptionKeys = readKeyring(config.AUTH_ENCRYPTION_KEYS, 'AUTH_ENCRYPTION_KEYS', { min: 32, max: 32 });
  const googleClientIds = config.AUTH_GOOGLE_CLIENT_IDS === undefined
    ? null
    : config.AUTH_GOOGLE_CLIENT_IDS.split(',').map((part) => part.trim()).filter((part) => part !== '');

  return {
    issuer: config.AUTH_ISSUER,
    secure: issuer.protocol === 'https:',
    jwtKeys,
    encryptionKeys,
    magicLinkUrl: config.AUTH_MAGIC_LINK_URL,
    totpIssuer: config.AUTH_TOTP_ISSUER,
    googleClientIds,
    webOrigins,
  };
}
