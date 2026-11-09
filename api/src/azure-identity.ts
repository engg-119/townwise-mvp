// Access tokens for Azure services from the Container App's user-assigned managed identity, over fetch (no Azure SDK),
// or, outside production with no identity, from the developer's Azure CLI sign-in (az login).
// One source serves every resource, with a cache per resource: email asks for https://communication.azure.com, and
// file storage wraps it as a TokenCredential for https://storage.azure.com. main.ts builds it only when a feature that
// needs it is on. Nothing here logs. A token, IDENTITY_HEADER and the endpoint's or the CLI's answer leave this file
// only as the return value; a failure is an AzureIdentityError carrying a code and the endpoint's HTTP status, never a
// body, or an Error whose message is AZURE_CLI_FAILURE and nothing else.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ConfigError } from '@ckeith26/server-core';
import { z } from 'zod';

/** The Container Apps token endpoint's version (learn.microsoft.com/azure/container-apps/managed-identity). */
export const IDENTITY_API_VERSION = '2019-08-01';
/** One token request, from the request to the last byte of the answer. */
export const IDENTITY_TIMEOUT_MS = 10_000;
/** A cached token is used until this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Where the platform serves tokens, and which identity to ask for. */
export interface ManagedIdentity {
  /** IDENTITY_ENDPOINT, set by Container Apps whenever an identity is assigned. */
  readonly endpoint: string;
  /** IDENTITY_HEADER, sent as X-IDENTITY-HEADER (it guards the endpoint against request forgery). */
  readonly header: string;
  /** AZURE_CLIENT_ID, set by containerapp.tf: the app has only a user-assigned identity, so every request names it. */
  readonly clientId: string;
}

const IDENTITY_VARIABLES = ['IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'AZURE_CLIENT_ID'] as const;

/**
 * The managed identity from the environment main.ts passes in. `feature` names what needs it, for the message.
 * Throws ConfigError naming each missing or malformed variable, never a value.
 */
export function resolveManagedIdentity(env: Readonly<Record<string, string | undefined>>, feature: string): ManagedIdentity {
  const problem = `${feature} needs the managed identity (IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID)`;
  const missing = IDENTITY_VARIABLES.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) throw new ConfigError(missing.map((variable) => ({ variable, problem })));
  const endpoint = env.IDENTITY_ENDPOINT ?? '';
  if (!URL.canParse(endpoint) || !['http:', 'https:'].includes(new URL(endpoint).protocol)) {
    throw new ConfigError('IDENTITY_ENDPOINT', 'expected an http or https URL');
  }
  return { endpoint, header: env.IDENTITY_HEADER ?? '', clientId: env.AZURE_CLIENT_ID ?? '' };
}

/** The token and when it expires, in epoch milliseconds (the shape @azure/core-auth's AccessToken uses). */
export interface AzureAccessToken {
  readonly token: string;
  readonly expiresOnTimestamp: number;
}

export type AzureIdentityFailure = 'timeout' | 'network' | 'upstream_status' | 'bad_response';

export class AzureIdentityError extends Error {
  readonly code: AzureIdentityFailure;
  /** The token endpoint's HTTP status, for `upstream_status`. */
  readonly status: number | null;
  /** The error class, for `network`. */
  readonly errType: string | null;

  constructor(code: AzureIdentityFailure, opts?: { status?: number; errType?: string }) {
    super('The managed identity token is unavailable');
    this.name = 'AzureIdentityError';
    this.code = code;
    this.status = opts?.status ?? null;
    this.errType = opts?.errType ?? null;
  }
}

export interface AzureTokenSource {
  /**
   * A token for `resource` (for example https://communication.azure.com). Throws AzureIdentityError, or from the Azure
   * CLI an Error with AZURE_CLI_FAILURE.
   */
  getToken(resource: string): Promise<AzureAccessToken>;
  /** Drops the cached token for `resource`, so the next call fetches a new one (after the service refused it). */
  invalidate(resource: string): void;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  // Seconds since the epoch; the endpoint answers it as a string.
  expires_on: z.union([z.string().regex(/^\d{1,12}$/), z.number().int().nonnegative()]),
});

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

function errTypeOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

/**
 * Caches each resource's token until TOKEN_REFRESH_MARGIN_MS before it expires. Concurrent callers for one resource
 * share one request; a failed request is not cached, so the next call tries again. No retries.
 */
function cachedPerResource(now: () => Date, request: (resource: string) => Promise<AzureAccessToken>): AzureTokenSource {
  const cached = new Map<string, AzureAccessToken>();
  const inFlight = new Map<string, Promise<AzureAccessToken>>();
  return {
    getToken: (resource) => {
      const hit = cached.get(resource);
      if (hit !== undefined && now().getTime() < hit.expiresOnTimestamp - TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(hit);
      const pending = inFlight.get(resource);
      if (pending !== undefined) return pending;
      const started = request(resource)
        .then((token) => {
          cached.set(resource, token);
          return token;
        })
        .finally(() => inFlight.delete(resource));
      inFlight.set(resource, started);
      return started;
    },
    invalidate: (resource) => {
      cached.delete(resource);
    },
  };
}

/** The managed identity's tokens, from the platform's token endpoint, cached as cachedPerResource says. */
export function createManagedIdentityTokenSource(deps: {
  identity: ManagedIdentity;
  now: () => Date;
  fetch?: FetchLike;
  timeoutMs?: number;
}): AzureTokenSource {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? IDENTITY_TIMEOUT_MS;

  const request = async (resource: string): Promise<AzureAccessToken> => {
    const url = new URL(deps.identity.endpoint);
    url.searchParams.set('resource', resource);
    url.searchParams.set('api-version', IDENTITY_API_VERSION);
    url.searchParams.set('client_id', deps.identity.clientId);
    let res: Response;
    try {
      res = await fetchFn(url.toString(), {
        method: 'GET',
        headers: { 'X-IDENTITY-HEADER': deps.identity.header },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw isTimeout(err) ? new AzureIdentityError('timeout') : new AzureIdentityError('network', { errType: errTypeOf(err) });
    }
    if (!res.ok) {
      if (res.body !== null) await res.body.cancel().catch(() => undefined);
      throw new AzureIdentityError('upstream_status', { status: res.status });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new AzureIdentityError(isTimeout(err) ? 'timeout' : 'bad_response');
    }
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new AzureIdentityError('bad_response');
    return { token: parsed.data.access_token, expiresOnTimestamp: Number(parsed.data.expires_on) * 1000 };
  };

  return cachedPerResource(deps.now, request);
}

/**
 * Whether main.ts takes tokens from the developer's Azure CLI sign-in instead of the managed identity: never in
 * production, and elsewhere only while IDENTITY_ENDPOINT and IDENTITY_HEADER are both absent. In production a missing
 * identity still refuses boot (resolveManagedIdentity).
 */
export function usesAzureCli(
  env: Readonly<Record<'IDENTITY_ENDPOINT' | 'IDENTITY_HEADER', string | undefined>>,
  nodeEnv: string,
): boolean {
  if (nodeEnv === 'production') return false;
  return (env.IDENTITY_ENDPOINT ?? '').trim() === '' && (env.IDENTITY_HEADER ?? '').trim() === '';
}

/** One `az account get-access-token` run, from start to exit. The CLI starts Python, so it is slower than the endpoint. */
export const AZURE_CLI_TIMEOUT_MS = 30_000;
/** The whole message of every Azure CLI failure: never the CLI's output, its error or a token. */
export const AZURE_CLI_FAILURE = 'The Azure CLI token is unavailable (run az login)';

/** Runs `file` with `args` and no shell, resolving with its stdout; rejects on a spawn error, a non-zero exit or a timeout. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

/** The runner createAzureCliTokenSource uses unless a test passes its own. execFile starts no shell. */
export const execFileRunner: CommandRunner = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { encoding: 'utf8', timeout: AZURE_CLI_TIMEOUT_MS, windowsHide: true });
  return stdout;
};

const cliTokenSchema = z.object({
  accessToken: z.string().min(1),
  // Seconds since the epoch, in recent Azure CLI versions.
  expires_on: z.number().int().positive().optional(),
  // Local time, "2026-11-09 13:45:12.000000", in older versions too.
  expiresOn: z.string().optional(),
});

const CLI_LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?$/;

/** Epoch milliseconds, from expires_on, else expiresOn read as local time (a date-time with no offset); NaN if neither. */
function cliExpiry(data: z.infer<typeof cliTokenSchema>): number {
  if (data.expires_on !== undefined) return data.expires_on * 1000;
  const match = CLI_LOCAL_TIME.exec(data.expiresOn ?? '');
  return match === null ? Number.NaN : Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}`);
}

/** The token in the CLI's answer, or null when there is none: never an error, which could carry the answer. */
function cliToken(stdout: string): AzureAccessToken | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = cliTokenSchema.safeParse(body);
  if (!parsed.success) return null;
  const expiresOnTimestamp = cliExpiry(parsed.data);
  return Number.isFinite(expiresOnTimestamp) ? { token: parsed.data.accessToken, expiresOnTimestamp } : null;
}

/**
 * Tokens from the developer's Azure CLI sign-in, for running the API locally with email on (main.ts, usesAzureCli). It
 * runs `az account get-access-token --resource <resource> -o json`, with the resource exactly as the managed identity
 * source asks for it, and caches as cachedPerResource says. Any failure throws an Error with AZURE_CLI_FAILURE as its
 * message and no cause, so the CLI's output, its error and the token never reach a message or a log.
 */
export function createAzureCliTokenSource(deps: { now: () => Date; run?: CommandRunner }): AzureTokenSource {
  const run = deps.run ?? execFileRunner;
  const request = async (resource: string): Promise<AzureAccessToken> => {
    let stdout: string;
    try {
      stdout = await run('az', ['account', 'get-access-token', '--resource', resource, '-o', 'json']);
    } catch {
      // The runner's error carries the CLI's stdout and stderr, so it goes no further.
      throw new Error(AZURE_CLI_FAILURE);
    }
    const token = cliToken(stdout);
    if (token === null) throw new Error(AZURE_CLI_FAILURE);
    return token;
  };
  return cachedPerResource(deps.now, request);
}
