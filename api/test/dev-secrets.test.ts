// Local Key Vault load (api/src/dev-secrets.ts): a missing Azure sign-in refuses the start before any secret
// is read, a required secret that is missing or unreadable refuses it, and an optional one that is absent is skipped.
// Values in these tests are fixtures. No assertion prints them, and no error message may contain one.
import { describe, expect, it } from 'vitest';

import { AZURE_CLI_FAILURE, type CommandRunner } from '../src/azure-identity.ts';
import { readFileSync } from 'node:fs';

import { PROD_COPY_OFF, prodCopyEnv } from '../scripts/prod-copy-env.ts';
import {
  AZURE_SIGNIN_MESSAGE, DEV_SECRETS_ENV, DEV_VAULT_NAME, DEV_VAULT_RESOURCE, DevSecretsError, developmentEnv, devSecretUrl,
  loadDeveloperSecrets, localOverVault, productionSuperadminEmails, type SecretFetch, type SecretRead,
} from '../src/dev-secrets.ts';

const CLIENT_ID = '789530597702-localclient.apps.googleusercontent.com';
const CALENDAR_KEY = Buffer.alloc(32, 7).toString('base64');
const CANARY = 'super-secret-value';

function cliAnswer(token: string): string {
  return JSON.stringify({ accessToken: token, expires_on: 2_000_000_000 });
}

function runner(stdout: string | Error): CommandRunner {
  return () => (stdout instanceof Error ? Promise.reject(stdout) : Promise.resolve(stdout));
}

function vault(values: Record<string, SecretRead>): { fetchSecret: SecretFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchSecret: (url) => {
      urls.push(url);
      const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
      return Promise.resolve(values[name] ?? { status: 404, value: null });
    },
  };
}

const ready: Record<string, SecretRead> = {
  'google-web-client-id': { status: 200, value: CLIENT_ID },
  'townwise-google-calendar-secret': { status: 200, value: CANARY },
  'townwise-calendar-key': { status: 200, value: CALENDAR_KEY },
  'anthropic-dev-key': { status: 200, value: 'anthropic-dev' },
  'google-places-api-key': { status: 404, value: null },
  'google-maps-static-key': { status: 200, value: 'maps-key' },
  'google-maps-signing-secret': { status: 403, value: null },
};

describe('loadDeveloperSecrets', () => {
  it('a missing Azure sign-in refuses to start and does not read Key Vault', async () => {
    const store = vault(ready);
    await expect(loadDeveloperSecrets({ target: 'server', run: runner(new Error(AZURE_CLI_FAILURE)), fetchSecret: store.fetchSecret })).rejects.toThrow(AZURE_SIGNIN_MESSAGE);
    expect(store.urls).toEqual([]);
  });

  it('an Azure CLI answer with no token is the same refusal', async () => {
    await expect(loadDeveloperSecrets({ target: 'client', run: runner('not json'), fetchSecret: vault(ready).fetchSecret })).rejects.toThrow(DevSecretsError);
  });

  it('the server load sets the sign-in id, the calendar secret and the calendar key, and skips an absent optional secret', async () => {
    const store = vault({ ...ready, 'google-maps-signing-secret': { status: 404, value: null } });
    const loaded = await loadDeveloperSecrets({ target: 'server', run: runner(cliAnswer('vault-token')), fetchSecret: store.fetchSecret });
    expect(loaded.AUTH_GOOGLE_CLIENT_IDS).toBe(CLIENT_ID);
    expect(loaded.TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID).toBe(CLIENT_ID);
    expect(loaded.TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET).toBe(CANARY);
    expect(loaded.TOWNWISE_CALENDAR_KEY).toBe(CALENDAR_KEY);
    expect(loaded.ANTHROPIC_API_KEY).toBe('anthropic-dev');
    expect(loaded.GOOGLE_MAPS_STATIC_KEY).toBe('maps-key');
    expect(loaded.GOOGLE_PLACES_API_KEY).toBeUndefined();
    expect(loaded.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).toBeUndefined();
    expect(store.urls.every((url) => url.startsWith(`https://${DEV_VAULT_NAME}.vault.azure.net/`) && !url.includes('vault-token'))).toBe(true);
    expect(store.urls).toContain(devSecretUrl(DEV_VAULT_NAME, 'townwise-google-calendar-secret'));
  });

  it('a required secret that is missing or unreadable refuses startup and the message does not contain the value', async () => {
    const missing = vault({ ...ready, 'google-web-client-id': { status: 404, value: null } });
    await expect(loadDeveloperSecrets({ target: 'server', run: runner(cliAnswer('vault-token')), fetchSecret: missing.fetchSecret })).rejects.toThrow(
      'Key Vault secret google-web-client-id was not found',
    );
    const denied = vault({ ...ready, 'townwise-google-calendar-secret': { status: 403, value: CANARY } });
    const error = await loadDeveloperSecrets({ target: 'server', run: runner(cliAnswer('vault-token')), fetchSecret: denied.fetchSecret }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DevSecretsError);
    expect(error instanceof Error ? error.message : '').toContain('townwise-google-calendar-secret');
    expect(error instanceof Error ? error.message : '').not.toContain(CANARY);
  });

  it('an optional secret the developer cannot read leaves that feature off', async () => {
    const loaded = await loadDeveloperSecrets({
      target: 'server', run: runner(cliAnswer('vault-token')), fetchSecret: vault(ready).fetchSecret,
    });
    expect(loaded.GOOGLE_MAPS_SIGNING_SECRET).toBeUndefined();
    expect(loaded.GOOGLE_MAPS_STATIC_KEY).toBe('maps-key');
    expect(loaded.ANTHROPIC_API_KEY).toBe('anthropic-dev');
  });

  it('the client load asks only for the public web client id', async () => {
    const store = vault(ready);
    const loaded = await loadDeveloperSecrets({ target: 'client', run: runner(cliAnswer('vault-token')), fetchSecret: store.fetchSecret });
    expect(loaded).toEqual({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: CLIENT_ID });
    expect(store.urls).toEqual([devSecretUrl(DEV_VAULT_NAME, 'google-web-client-id')]);
  });

  it('a client id or calendar key in the wrong shape refuses startup without echoing it', async () => {
    const badId = vault({ ...ready, 'google-web-client-id': { status: 200, value: CANARY } });
    const idError = await loadDeveloperSecrets({ target: 'client', run: runner(cliAnswer('t')), fetchSecret: badId.fetchSecret }).catch((err: unknown) => err);
    expect(idError instanceof Error ? idError.message : '').toBe('Key Vault secret google-web-client-id must be one Google OAuth web client id.');
    expect(idError instanceof Error ? idError.message : '').not.toContain(CANARY);
    const badKey = vault({ ...ready, 'townwise-calendar-key': { status: 200, value: 'not-a-key' } });
    await expect(loadDeveloperSecrets({ target: 'server', run: runner(cliAnswer('t')), fetchSecret: badKey.fetchSecret })).rejects.toThrow(
      'townwise-calendar-key must be 32 bytes of base64',
    );
  });

  it('a complete .env.local starts without Azure, and a missing required secret still refuses', async () => {
    const store = vault(ready);
    const localClient = [{ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: CLIENT_ID }];
    const loaded = await loadDeveloperSecrets({
      target: 'client', run: runner(new Error(AZURE_CLI_FAILURE)), fetchSecret: store.fetchSecret, local: localClient,
    });
    expect(loaded).toEqual({});
    expect(store.urls).toEqual([]);
    const present = {
      AUTH_GOOGLE_CLIENT_IDS: CLIENT_ID,
      TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID: CLIENT_ID,
      TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET: 'local-secret',
      TOWNWISE_CALENDAR_KEY: CALENDAR_KEY,
    };
    await expect(loadDeveloperSecrets({
      target: 'server', run: runner(new Error(AZURE_CLI_FAILURE)), fetchSecret: store.fetchSecret, local: [present],
    })).resolves.toEqual({});
    await expect(loadDeveloperSecrets({
      target: 'server', run: runner(new Error(AZURE_CLI_FAILURE)), fetchSecret: store.fetchSecret,
      local: [{ AUTH_GOOGLE_CLIENT_IDS: CLIENT_ID }],
    })).rejects.toThrow(AZURE_SIGNIN_MESSAGE);
  });

  it('the local API keeps a file override, and the production copy still turns calendars, files and email off', () => {
    const file = {
      PORT: '8080', MONGODB_URI: 'mongodb://localhost:27017/townwise',
      AUTH_GOOGLE_CLIENT_IDS: 'from-file', ANTHROPIC_API_KEY: '',
      TOWNWISE_CALENDAR_KEY: 'from-file', FILES_BLOB_ACCOUNT_URL: 'http://127.0.0.1:10000/devstoreaccount1',
      EMAIL_ENDPOINT: 'https://x.communication.azure.com',
    };
    const secrets = {
      AUTH_GOOGLE_CLIENT_IDS: 'from-vault', ANTHROPIC_API_KEY: 'from-vault',
      TOWNWISE_CALENDAR_KEY: 'from-vault', TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET: 'from-vault',
      GOOGLE_PLACES_API_KEY: 'from-vault',
    };
    const env = developmentEnv(file, { GOOGLE_MAPS_STATIC_KEY: 'from-shell' }, secrets);
    expect(env.AUTH_GOOGLE_CLIENT_IDS).toBe('from-file');
    expect(env.ANTHROPIC_API_KEY).toBe('from-vault');
    expect(env.GOOGLE_MAPS_STATIC_KEY).toBe('from-shell');
    expect(env.GOOGLE_PLACES_API_KEY).toBe('from-vault');
    expect(env[DEV_SECRETS_ENV]).toBe('1');
    expect(env.TOWNWISE_SUPERADMIN_EMAILS?.split(',')).toHaveLength(6);
    const copy = prodCopyEnv(env);
    for (const name of PROD_COPY_OFF) expect(copy).not.toHaveProperty(name);
    expect(copy.ANTHROPIC_API_KEY).toBe('from-vault');
    expect(copy.AUTH_GOOGLE_CLIENT_IDS).toBe('from-file');
    expect(copy.MONGODB_URI).toBe('mongodb://localhost:27017/townwise_prod');
  });

  it('uses production’s six superadmins unless the local file sets its own list', () => {
    const listed = productionSuperadminEmails(readFileSync(new URL('../production.env', import.meta.url), 'utf8'));
    expect(listed.split(',')).toEqual([
      'katie.j.sellu.th@dartmouth.edu',
      'cameron.s.keith.gr@dartmouth.edu',
      'marianna.cardin.th@dartmouth.edu',
      'tejus.guddadaranganahalli.rajashekar.th@dartmouth.edu',
      'laura.a.ridlehoover@dartmouth.edu',
      'eugene.santos.jr@dartmouth.edu',
    ]);
    expect(developmentEnv({}, {}, {}, 'TOWNWISE_SUPERADMIN_EMAILS=\n').TOWNWISE_SUPERADMIN_EMAILS).toBeUndefined();
    expect(developmentEnv({ TOWNWISE_SUPERADMIN_EMAILS: 'one@dartmouth.edu' }, {}, {}).TOWNWISE_SUPERADMIN_EMAILS).toBe('one@dartmouth.edu');
  });

  it('a non-empty .env.local value replaces the Key Vault value, and an empty one does not', () => {
    const secrets = { AUTH_GOOGLE_CLIENT_IDS: 'from-vault', ANTHROPIC_API_KEY: 'vault-key', GOOGLE_PLACES_API_KEY: 'vault-places' };
    const merged = localOverVault(secrets, [
      { AUTH_GOOGLE_CLIENT_IDS: 'from-file', ANTHROPIC_API_KEY: '' },
      { ANTHROPIC_API_KEY: 'from-shell', GOOGLE_PLACES_API_KEY: 'from-shell' },
    ]);
    expect(merged).toEqual({
      AUTH_GOOGLE_CLIENT_IDS: 'from-file',
      ANTHROPIC_API_KEY: 'from-shell',
      GOOGLE_PLACES_API_KEY: 'from-shell',
    });
  });

  it('the token request is for the Key Vault resource', async () => {
    const runs: string[][] = [];
    const run: CommandRunner = (_file, args) => {
      runs.push([...args]);
      return Promise.resolve(cliAnswer('vault-token'));
    };
    await loadDeveloperSecrets({ target: 'client', run, fetchSecret: vault(ready).fetchSecret });
    expect(runs).toEqual([['account', 'get-access-token', '--resource', DEV_VAULT_RESOURCE, '-o', 'json']]);
  });
});
