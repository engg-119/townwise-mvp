// Developer Key Vault secrets for a local start (npm run dev, npm start, the weekly worker in development).
// One `az account get-access-token` proves the developer is signed in, then each secret is read over HTTPS.
// Nothing here writes a file or logs a value, a token, or the CLI's output. Production never calls this:
// Container Apps injects its own Key Vault references, and a missing sign-in there is not an `az login` problem.
import { readFileSync } from 'node:fs';

import { createAzureCliTokenSource, type CommandRunner } from './azure-identity.ts';

/** Set by the dev scripts after a successful load. main.ts refuses to boot in development without it. */
export const DEV_SECRETS_ENV = 'TOWNWISE_DEV_SECRETS';

/** The production vault. Developers hold Key Vault Secrets User on specific secret names, never on the vault. */
export const DEV_VAULT_NAME = 'kv-townwise-2d2c15bf';

/** Resource name `az account get-access-token` expects for Key Vault data-plane calls. */
export const DEV_VAULT_RESOURCE = 'https://vault.azure.net';

const VAULT_API_VERSION = '7.4';

/** Shown when `az` is missing, signed out, or returns no token. The CLI's own output is never attached. */
export const AZURE_SIGNIN_MESSAGE = 'Azure sign-in is required to start Townwise. Run `az login`, then start again.';

/** Same shape as config.ts's GOOGLE_CLIENT_ID. One web client id, not a list. */
const GOOGLE_CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export class DevSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevSecretsError';
  }
}

export type DevSecretsTarget = 'server' | 'client';

interface SecretBinding {
  /** Key Vault secret name. */
  readonly secret: string;
  /** Env vars set from that one value. The client process only receives EXPO_PUBLIC_* names. */
  readonly env: readonly string[];
  /** A 404 refuses startup. An optional secret that is absent leaves its feature off. */
  readonly required: boolean;
  /** Included when the Expo process asks for its public client id. */
  readonly client: boolean;
}

/**
 * Secrets townwise-developers may read (infra/terraform/bootstrap/team.tf). The Google web client id is public;
 * the calendar client secret and the calendar key are not, and neither is ever given to the Expo process.
 */
export const DEV_SECRET_BINDINGS: readonly SecretBinding[] = [
  {
    secret: 'google-web-client-id',
    env: ['AUTH_GOOGLE_CLIENT_IDS', 'TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'],
    required: true,
    client: true,
  },
  { secret: 'townwise-google-calendar-secret', env: ['TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET'], required: true, client: false },
  { secret: 'townwise-calendar-key', env: ['TOWNWISE_CALENDAR_KEY'], required: true, client: false },
  { secret: 'anthropic-dev-key', env: ['ANTHROPIC_API_KEY'], required: false, client: false },
  { secret: 'google-places-api-key', env: ['GOOGLE_PLACES_API_KEY'], required: false, client: false },
  { secret: 'google-maps-static-key', env: ['GOOGLE_MAPS_STATIC_KEY'], required: false, client: false },
  { secret: 'google-maps-signing-secret', env: ['GOOGLE_MAPS_SIGNING_SECRET'], required: false, client: false },
];

export interface SecretRead {
  readonly status: number;
  /** Null when the secret is absent, empty, or not a JSON object with a string `value`. */
  readonly value: string | null;
}

/** Reads one secret. `token` is the Key Vault bearer token and must not be placed in `url`. */
export type SecretFetch = (url: string, token: string) => Promise<SecretRead>;

export function devSecretUrl(vault: string, name: string): string {
  return `https://${vault}.vault.azure.net/secrets/${encodeURIComponent(name)}?api-version=${VAULT_API_VERSION}`;
}

function envNames(binding: SecretBinding, target: DevSecretsTarget): readonly string[] {
  return target === 'client' ? binding.env.filter((name) => name.startsWith('EXPO_PUBLIC_')) : binding.env.filter((name) => !name.startsWith('EXPO_PUBLIC_'));
}

function alreadySet(
  names: readonly string[],
  layers: readonly (Readonly<Record<string, string | undefined>>)[],
): boolean {
  return names.every((name) => layers.some((layer) => {
    const value = layer[name];
    return value !== undefined && value !== '';
  }));
}

function bindingsFor(target: DevSecretsTarget): readonly SecretBinding[] {
  return DEV_SECRET_BINDINGS.filter((binding) => target === 'server' || binding.client);
}

/** Bindings whose env vars are still empty in `.env.local` and the shell. */
function missingBindings(
  target: DevSecretsTarget,
  local: readonly (Readonly<Record<string, string | undefined>>)[],
): readonly SecretBinding[] {
  return bindingsFor(target).filter((binding) => {
    const names = envNames(binding, target);
    return names.length > 0 && !alreadySet(names, local);
  });
}

/** Refuses a web client id or a calendar key that config.ts would refuse, without echoing the value. */
function rejectMalformed(binding: SecretBinding, value: string): void {
  if (binding.secret === 'google-web-client-id' && !GOOGLE_CLIENT_ID.test(value)) {
    throw new DevSecretsError(`Key Vault secret ${binding.secret} must be one Google OAuth web client id.`);
  }
  if (binding.secret === 'townwise-calendar-key') {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== value) {
      throw new DevSecretsError(`Key Vault secret ${binding.secret} must be 32 bytes of base64.`);
    }
  }
}

function failure(binding: SecretBinding, read: SecretRead): DevSecretsError | null {
  if (read.status === 200 && read.value !== null) return null;
  if (read.status === 404 && !binding.required) return null;
  if (read.status === 0) return new DevSecretsError(`Could not reach Key Vault to read ${binding.secret}.`);
  if (read.status === 404) return new DevSecretsError(`Signed in to Azure, but Key Vault secret ${binding.secret} was not found.`);
  const status = read.status === 200 ? 'empty' : `HTTP ${String(read.status)}`;
  return new DevSecretsError(`Signed in to Azure, but Key Vault secret ${binding.secret} is not readable (${status}).`);
}

async function defaultFetch(url: string, token: string): Promise<SecretRead> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  } catch {
    return { status: 0, value: null };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, value: null };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: response.status, value: null };
  }
  if (typeof body !== 'object' || body === null || !('value' in body) || typeof body.value !== 'string' || body.value === '') {
    return { status: response.status, value: null };
  }
  return { status: 200, value: body.value };
}

/**
 * A non-empty value in an earlier layer replaces the Key Vault value for that name. Empty does not.
 * `layers` is highest priority first: `.env.local`, then the shell. Names Key Vault did not return are left untouched.
 */
/**
 * The process environment for a local start. `.env.local` replaces a Key Vault value, then the shell, then the vault.
 * Empty values do not count. `TOWNWISE_DEV_SECRETS` is set so main.ts will boot.
 */
/** The public staff list in api/production.env. Empty when the line is missing. */
export function productionSuperadminEmails(text: string): string {
  const line = text.split('\n').find((entry) => entry.startsWith('TOWNWISE_SUPERADMIN_EMAILS='));
  if (line === undefined) return '';
  return line.slice('TOWNWISE_SUPERADMIN_EMAILS='.length).split(',').map((email) => email.trim()).filter((email) => email !== '').join(',');
}

export function developmentEnv(
  file: Readonly<Record<string, string | undefined>>,
  shell: Readonly<Record<string, string | undefined>>,
  secrets: Readonly<Record<string, string>>,
  productionEnv = readFileSync(new URL('../production.env', import.meta.url), 'utf8'),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of [file, shell, localOverVault(secrets, [file, shell])]) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== '') env[key] = value;
    }
  }
  // Same staff list as production unless .env.local or the shell already set one.
  if ((env.TOWNWISE_SUPERADMIN_EMAILS ?? '') === '') {
    const staff = productionSuperadminEmails(productionEnv);
    if (staff !== '') env.TOWNWISE_SUPERADMIN_EMAILS = staff;
  }
  env[DEV_SECRETS_ENV] = '1';
  return env;
}

export function localOverVault(
  secrets: Readonly<Record<string, string>>,
  layers: readonly (Readonly<Record<string, string | undefined>>)[],
): Record<string, string> {
  const out: Record<string, string> = { ...secrets };
  for (const name of Object.keys(secrets)) {
    for (const layer of layers) {
      const value = layer[name];
      if (value !== undefined && value !== '') {
        out[name] = value;
        break;
      }
    }
  }
  return out;
}

/** Throws DevSecretsError when `az login` is missing. The token is discarded. */
export async function assertAzureSignedIn(run?: CommandRunner): Promise<void> {
  await vaultAccessToken(run);
}

async function vaultAccessToken(run?: CommandRunner, now?: () => Date): Promise<string> {
  const tokens = createAzureCliTokenSource({ now: now ?? ((): Date => new Date()), ...(run === undefined ? {} : { run }) });
  try {
    return (await tokens.getToken(DEV_VAULT_RESOURCE)).token;
  } catch {
    throw new DevSecretsError(AZURE_SIGNIN_MESSAGE);
  }
}

/**
 * Fills developer secrets that `.env.local` and the shell left empty. When every binding is already set, Azure is
 * not contacted. A missing sign-in refuses startup only when a required secret is still empty. Optional secrets
 * that cannot be read are left off. Callers pass the result through `developmentEnv`.
 */
export async function loadDeveloperSecrets(deps: {
  target: DevSecretsTarget;
  run?: CommandRunner;
  fetchSecret?: SecretFetch;
  vault?: string;
  now?: () => Date;
  /** Highest priority first. A binding whose names are all non-empty here is not read from Key Vault. */
  local?: readonly (Readonly<Record<string, string | undefined>>)[];
}): Promise<Record<string, string>> {
  const vault = deps.vault ?? DEV_VAULT_NAME;
  const fetchSecret = deps.fetchSecret ?? defaultFetch;
  const local = deps.local ?? [];
  const missing = missingBindings(deps.target, local);
  if (missing.length === 0) return {};
  let token: string;
  try {
    token = await vaultAccessToken(deps.run, deps.now);
  } catch (err) {
    if (missing.some((binding) => binding.required)) throw err;
    return {};
  }
  const out: Record<string, string> = {};
  for (const binding of missing) {
    const names = envNames(binding, deps.target);
    const read = await fetchSecret(devSecretUrl(vault, binding.secret), token);
    const problem = failure(binding, read);
    if (problem !== null) {
      if (binding.required) throw problem;
      continue;
    }
    if (read.value === null) continue;
    rejectMalformed(binding, read.value);
    for (const name of names) out[name] = read.value;
  }
  return out;
}
