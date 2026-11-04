import { isIP } from 'node:net';

import { ConfigError } from './config.ts';

const NAMED_TOKENS: ReadonlySet<string> = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isCidr(token: string): boolean {
  const slash = token.lastIndexOf('/');
  if (slash <= 0) return false;
  const address = token.slice(0, slash);
  const prefixText = token.slice(slash + 1);
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  const family = isIP(address);
  if (family === 4) return prefix <= 32;
  if (family === 6) return prefix <= 128;
  return false;
}

function isTrustToken(token: string): boolean {
  return NAMED_TOKENS.has(token) || isIP(token) > 0 || isCidr(token);
}

/** Tokens for `app.set('trust proxy', ...)`. Hop counts and `true` are refused. */
export function parseTrustProxy(raw: string): string[] {
  const tokens = raw.split(',').map((token) => token.trim()).filter((token) => token !== '');
  if (tokens.length === 0 || tokens.some((token) => !isTrustToken(token))) {
    const index = tokens.findIndex((token) => !isTrustToken(token));
    const position = index === -1 ? 1 : index + 1;
    throw new ConfigError(
      'TRUST_PROXY',
      `token ${String(position)} is not loopback, linklocal, uniquelocal, an IP or a CIDR`,
    );
  }
  return tokens;
}
