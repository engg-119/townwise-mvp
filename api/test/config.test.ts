import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ConfigError, loadEnv } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import { configSchema, filesBackendOf, labRunnerOf, resolveTownwiseConfig } from '../src/config.ts';

function parse(value: string | undefined): readonly string[] {
  return loadEnv(configSchema, { TOWNWISE_SUPERADMIN_EMAILS: value }).TOWNWISE_SUPERADMIN_EMAILS;
}

describe('config', () => {
  it('allows an empty or missing staff list', () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse('')).toEqual([]);
  });

  it('normalizes each address like the kit and drops duplicates and empty entries', () => {
    expect(parse(' Staff@Townwise.TEST, ops@townwise.test,,staff@townwise.test ')).toEqual([
      'staff@townwise.test', 'ops@townwise.test',
    ]);
  });

  it('refuses an entry that is not an email, without echoing it', () => {
    try {
      parse('staff@townwise.test,secret-value-not-an-email');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).toContain('TOWNWISE_SUPERADMIN_EMAILS');
      expect(String(err)).not.toContain('secret-value');
    }
  });

  it('refuses more than 20 addresses', () => {
    const list = Array.from({ length: 21 }, (_, i) => `staff${String(i)}@townwise.test`).join(',');
    expect(() => parse(list)).toThrow(ConfigError);
    expect(parse(list.split(',').slice(0, 20).join(','))).toHaveLength(20);
  });

  it('production refuses an empty staff list; development and test allow it', () => {
    const budget = {
      TOWNWISE_CHAT_MONTHLY_BUDGET_USD: 20, TOWNWISE_WEB_URL: 'http://localhost:8081',
      FILES_BLOB_ACCOUNT_URL: undefined, FILES_AZURITE_CONNECTION_STRING: undefined, TOWNWISE_FILES_MONTHLY_BUDGET_USD: 5,
    };
    expect(() => resolveTownwiseConfig({ NODE_ENV: 'production', TOWNWISE_SUPERADMIN_EMAILS: [], ...budget })).toThrow(ConfigError);
    expect(resolveTownwiseConfig({ NODE_ENV: 'development', TOWNWISE_SUPERADMIN_EMAILS: [], ...budget }).superadminEmails.size).toBe(0);
    const resolved = resolveTownwiseConfig({ NODE_ENV: 'production', TOWNWISE_SUPERADMIN_EMAILS: ['staff@townwise.test'], ...budget });
    expect(resolved.superadminEmails.has('staff@townwise.test')).toBe(true);
  });

  it('staff two-step sign-in is off by default in development only, and production refuses off', () => {
    const base = {
      TOWNWISE_SUPERADMIN_EMAILS: ['staff@townwise.test'], TOWNWISE_CHAT_MONTHLY_BUDGET_USD: 20, TOWNWISE_WEB_URL: 'http://localhost:8081',
      FILES_BLOB_ACCOUNT_URL: undefined, FILES_AZURITE_CONNECTION_STRING: undefined, TOWNWISE_FILES_MONTHLY_BUDGET_USD: 5,
    };
    const twoStep = (nodeEnv: 'development' | 'test' | 'production', value?: string): boolean => resolveTownwiseConfig({
      NODE_ENV: nodeEnv, ...base, TOWNWISE_STAFF_TWO_STEP: loadEnv(configSchema, { TOWNWISE_STAFF_TWO_STEP: value }).TOWNWISE_STAFF_TWO_STEP,
    }).staffTwoStep;
    expect(twoStep('development')).toBe(false);
    expect(twoStep('development', '')).toBe(false);
    expect(twoStep('development', 'required')).toBe(true);
    expect(twoStep('test')).toBe(true);
    expect(twoStep('test', 'off')).toBe(false);
    expect(twoStep('production')).toBe(true);
    expect(() => twoStep('production', 'off')).toThrow(ConfigError);
    expect(() => loadEnv(configSchema, { TOWNWISE_STAFF_TWO_STEP: 'maybe' })).toThrow(ConfigError);
  });

  it('reads the tuning chat budget in dollars, 20 by default, and refuses a value that is not a number from 0 to 10,000', () => {
    const budget = (value: string | undefined): number =>
      loadEnv(configSchema, { TOWNWISE_CHAT_MONTHLY_BUDGET_USD: value }).TOWNWISE_CHAT_MONTHLY_BUDGET_USD;
    expect(budget(undefined)).toBe(20);
    expect(budget('')).toBe(20);
    expect(budget('35.5')).toBe(35.5);
    expect(budget('0')).toBe(0);
    for (const bad of ['-1', 'twenty', '10001']) expect(() => budget(bad)).toThrow(ConfigError);
  });

  it('reads the file reader’s AI budget in dollars, 5 by default, 0 turning it off, and refuses anything outside 0 to 1,000', () => {
    const budget = (value: string | undefined): number =>
      loadEnv(configSchema, { TOWNWISE_FILES_MONTHLY_BUDGET_USD: value }).TOWNWISE_FILES_MONTHLY_BUDGET_USD;
    expect(budget(undefined)).toBe(5);
    expect(budget('0')).toBe(0);
    expect(budget('12.5')).toBe(12.5);
    for (const bad of ['-1', 'five', '1001']) expect(() => budget(bad)).toThrow(ConfigError);
  });

  describe('email (spec D14)', () => {
    const ENDPOINT = 'https://acs-townwise-0000.unitedstates.communication.azure.com';
    const SENDER = 'no-reply@townwise.test';

    function resolve(env: Record<string, string | undefined>, nodeEnv: 'production' | 'development' = 'development') {
      return resolveTownwiseConfig({ NODE_ENV: nodeEnv, ...loadEnv(configSchema, { TOWNWISE_SUPERADMIN_EMAILS: 'staff@townwise.test', ...env }) });
    }

    function problemsOf(run: () => unknown): string[] {
      try {
        run();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as ConfigError).problems.map((problem) => problem.variable);
      }
      return expect.unreachable();
    }

    it('is off by default, with the local web origin and no Reply-To; empty values count as unset', () => {
      expect(resolve({})).toMatchObject({ email: null, emailReplyTo: null, webUrl: 'http://localhost:8081' });
      expect(resolve({ EMAIL_ENDPOINT: '', EMAIL_SENDER: '', TOWNWISE_EMAIL_REPLY_TO: '', TOWNWISE_WEB_URL: '' }).email).toBeNull();
    });

    it('is on with an endpoint and a sender; the endpoint and web URL lose a trailing slash', () => {
      const resolved = resolve({
        EMAIL_ENDPOINT: `${ENDPOINT}/`, EMAIL_SENDER: SENDER, TOWNWISE_EMAIL_REPLY_TO: 'team@townwise.test', TOWNWISE_WEB_URL: 'https://townwise.test/',
      }, 'production');
      expect(resolved).toMatchObject({
        email: { endpoint: ENDPOINT, sender: SENDER }, emailReplyTo: 'team@townwise.test', webUrl: 'https://townwise.test',
      });
    });

    it('needs EMAIL_ENDPOINT and EMAIL_SENDER together', () => {
      expect(problemsOf(() => resolve({ EMAIL_ENDPOINT: ENDPOINT }))).toEqual(['EMAIL_SENDER']);
      expect(problemsOf(() => resolve({ EMAIL_SENDER: SENDER }))).toEqual(['EMAIL_ENDPOINT']);
    });

    it('refuses an endpoint that is not https on *.communication.azure.com, or has a path, without echoing it', () => {
      for (const bad of [
        'http://acs-townwise-0000.unitedstates.communication.azure.com',
        'https://sentinel-host.example.test',
        'https://acs.communication.azure.com.sentinel-host.example.test',
        `${ENDPOINT}/sentinel-path`,
        `${ENDPOINT}?sentinel=1`,
      ]) {
        try {
          resolve({ EMAIL_ENDPOINT: bad, EMAIL_SENDER: SENDER });
          expect.unreachable(bad);
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigError);
          expect((err as ConfigError).problems.map((problem) => problem.variable)).toEqual(['EMAIL_ENDPOINT']);
          expect(String(err)).not.toContain('sentinel');
        }
      }
    });

    it('refuses a sender or Reply-To that is not an address, and a web URL with a path or another scheme', () => {
      expect(problemsOf(() => resolve({ EMAIL_ENDPOINT: ENDPOINT, EMAIL_SENDER: 'no-reply' }))).toEqual(['EMAIL_SENDER']);
      expect(problemsOf(() => resolve({ TOWNWISE_EMAIL_REPLY_TO: 'team' }))).toEqual(['TOWNWISE_EMAIL_REPLY_TO']);
      expect(problemsOf(() => resolve({ TOWNWISE_WEB_URL: 'https://townwise.test/sign-in' }))).toEqual(['TOWNWISE_WEB_URL']);
      expect(problemsOf(() => resolve({ TOWNWISE_WEB_URL: 'ftp://townwise.test' }))).toEqual(['TOWNWISE_WEB_URL']);
    });

    it('production refuses an http web URL while email is on, and allows it while email is off', () => {
      expect(problemsOf(() => resolve({ EMAIL_ENDPOINT: ENDPOINT, EMAIL_SENDER: SENDER }, 'production'))).toEqual(['TOWNWISE_WEB_URL']);
      expect(resolve({ EMAIL_ENDPOINT: ENDPOINT, EMAIL_SENDER: SENDER }).webUrl).toBe('http://localhost:8081');
      expect(resolve({}, 'production').email).toBeNull();
    });
  });

  it('turns stored files on with an account URL, and refuses Azurite and a plain-HTTP account in production, without echoing either', () => {
    const files = (env: Record<string, string>, nodeEnv: 'production' | 'development') =>
      filesBackendOf({ ...loadEnv(configSchema, env), NODE_ENV: nodeEnv });
    expect(files({}, 'production')).toBeNull();
    expect(files({ FILES_BLOB_ACCOUNT_URL: '' }, 'development')).toBeNull();
    expect(files({ FILES_BLOB_ACCOUNT_URL: 'https://sttwfiles2d2c15bf.blob.core.windows.net' }, 'production'))
      .toEqual({ kind: 'azure', accountUrl: 'https://sttwfiles2d2c15bf.blob.core.windows.net' });
    const azurite = { FILES_BLOB_ACCOUNT_URL: 'http://127.0.0.1:10000/devstoreaccount1', FILES_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true' };
    expect(files(azurite, 'development')).toEqual({ kind: 'azurite', connectionString: 'UseDevelopmentStorage=true' });
    for (const env of [azurite, { FILES_BLOB_ACCOUNT_URL: 'http://sttwfiles2d2c15bf.blob.core.windows.net' }]) {
      try {
        files(env, 'production');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect(String(err)).not.toContain('UseDevelopmentStorage');
        expect(String(err)).not.toContain('sttwfiles');
      }
    }
    expect(() => resolveTownwiseConfig({
      NODE_ENV: 'production', TOWNWISE_SUPERADMIN_EMAILS: ['staff@townwise.test'], TOWNWISE_CHAT_MONTHLY_BUDGET_USD: 20,
      TOWNWISE_WEB_URL: 'http://localhost:8081', TOWNWISE_FILES_MONTHLY_BUDGET_USD: 5, ...azurite,
    })).toThrow(ConfigError);
    expect(() => loadEnv(configSchema, { FILES_BLOB_ACCOUNT_URL: 'not a url' })).toThrow(ConfigError);
  });

  describe('the calendar key', () => {
    const key = (value: string | undefined) => loadEnv(configSchema, { TOWNWISE_CALENDAR_KEY: value }).TOWNWISE_CALENDAR_KEY;

    it('is optional: unset or empty turns calendar links off', () => {
      expect(key(undefined)).toBeUndefined();
      expect(key('')).toBeUndefined();
    });

    it('main.ts builds the refresh loop only when it is set, starts it, and drains it at shutdown before Redis and Mongo close', () => {
      // The calendar-subscription spec: without the key no refresh runs (tasks 5.2).
      const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
      expect(main.match(/\bcreateCalendarRefresher\(/g)).toHaveLength(1);
      expect(main).toMatch(/^const calendarRefresher = TOWNWISE_CALENDAR_KEY === undefined \? undefined : createCalendarRefresher\(\{$/m);
      expect(main).toMatch(/^calendarRefresher\?\.start\(\);/m);
      const shutdown = main.slice(main.indexOf('onShutdown: ['));
      const drained = shutdown.indexOf('...(calendarRefresher === undefined ? [] : [calendarRefresher])');
      expect(drained).toBeGreaterThan(0);
      expect(drained).toBeLessThan(shutdown.indexOf('redis, mongo,'));
    });

    it('reads 32 bytes of base64, as openssl rand -base64 32 writes them, into a secret key', () => {
      const bytes = randomBytes(32);
      const parsed = key(bytes.toString('base64'));
      expect(parsed?.type).toBe('secret');
      expect(parsed?.symmetricKeySize).toBe(32);
      expect(parsed?.export().equals(bytes)).toBe(true);
    });

    it('refuses boot for anything else, naming the variable and how to make one, never the value', () => {
      const bytes = Buffer.alloc(32, 0xfb);   // base64 '+/', base64url '-_'
      for (const bad of [
        randomBytes(16).toString('base64'),
        randomBytes(33).toString('base64'),
        randomBytes(64).toString('base64'),
        bytes.toString('base64url'),
        bytes.toString('base64').replace(/=$/, ''),
        `${bytes.toString('base64')}\n`,
        ` ${bytes.toString('base64')}`,
        bytes.toString('hex'),
        'sentinel-not-a-key',
      ]) {
        try {
          key(bad);
          expect.unreachable(bad);
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigError);
          expect((err as ConfigError).problems).toEqual([
            { variable: 'TOWNWISE_CALENDAR_KEY', problem: 'expected 32 random bytes in base64 (openssl rand -base64 32)' },
          ]);
          expect(String(err)).not.toContain(bad.trim());
        }
      }
    });
  });

  describe('the forecast lab runner', () => {
    const JOB_ID = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-lab';
    // The lab callback app's client id, the lab identity's principal id and the tenant (azure only, set by Terraform).
    const CALLER = {
      TOWNWISE_LAB_AUDIENCE: '22222222-2222-4222-8222-222222222222',
      TOWNWISE_LAB_CALLER_ID: '33333333-3333-4333-8333-333333333333',
      TOWNWISE_LAB_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    };
    const AZURE = { kind: 'azure', jobId: JOB_ID, caller: { audience: CALLER.TOWNWISE_LAB_AUDIENCE, objectId: CALLER.TOWNWISE_LAB_CALLER_ID, tenantId: CALLER.TOWNWISE_LAB_TENANT_ID } };
    const lab = (env: Record<string, string>) => labRunnerOf(loadEnv(configSchema, env));

    function problemsOf(run: () => unknown): string[] {
      try {
        run();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect(String(err)).not.toContain('sentinel');
        return (err as ConfigError).problems.map((problem) => problem.variable);
      }
      return expect.unreachable();
    }

    it('is off by default, and off ignores the other variables', () => {
      expect(lab({})).toBeNull();
      expect(lab({ TOWNWISE_LAB_RUNNER: '' })).toBeNull();
      expect(lab({ TOWNWISE_LAB_RUNNER: 'off', TOWNWISE_LAB_JOB_ID: JOB_ID, TOWNWISE_LAB_API_URL: 'http://localhost:8080', ...CALLER })).toBeNull();
    });

    it('local runs uv in ../modeling/lab by default and calls back on the bare origin given', () => {
      expect(lab({ TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'http://localhost:8080/' }))
        .toEqual({ kind: 'local', apiUrl: 'http://localhost:8080', projectDir: '../modeling/lab' });
      expect(lab({ TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'http://localhost:8080', TOWNWISE_LAB_PROJECT_DIR: '/srv/lab' }))
        .toMatchObject({ projectDir: '/srv/lab' });
      // local needs none of azure's sign-in variables, and ignores them.
      expect(lab({ TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'http://localhost:8080', ...CALLER }))
        .toEqual({ kind: 'local', apiUrl: 'http://localhost:8080', projectDir: '../modeling/lab' });
    });

    it('production refuses local, as it refuses Azurite', () => {
      const env = { TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'http://localhost:8080' };
      expect(problemsOf(() => labRunnerOf({ ...loadEnv(configSchema, env), NODE_ENV: 'production' }))).toEqual(['TOWNWISE_LAB_RUNNER']);
      expect(labRunnerOf({ ...loadEnv(configSchema, env), NODE_ENV: 'development' })).toMatchObject({ kind: 'local' });
      expect(labRunnerOf({ ...loadEnv(configSchema, { TOWNWISE_LAB_RUNNER: 'azure', TOWNWISE_LAB_JOB_ID: JOB_ID, ...CALLER }), NODE_ENV: 'production' }))
        .toEqual(AZURE);
    });

    it('azure starts the job by its resource id and accepts only the lab identity’s token for the callback app', () => {
      expect(lab({ TOWNWISE_LAB_RUNNER: 'azure', TOWNWISE_LAB_JOB_ID: JOB_ID, ...CALLER })).toEqual(AZURE);
    });

    it('azure without any of its sign-in variables refuses boot naming each missing one', () => {
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'azure', TOWNWISE_LAB_JOB_ID: JOB_ID })))
        .toEqual(['TOWNWISE_LAB_AUDIENCE', 'TOWNWISE_LAB_CALLER_ID', 'TOWNWISE_LAB_TENANT_ID']);
      for (const name of Object.keys(CALLER)) {
        const env: Record<string, string> = { TOWNWISE_LAB_RUNNER: 'azure', TOWNWISE_LAB_JOB_ID: JOB_ID, ...CALLER };
        env[name] = '';
        expect(problemsOf(() => lab(env))).toEqual([name]);
        // A value that is not a GUID refuses boot too, naming the variable and not the value.
        env[name] = 'sentinel-not-a-guid';
        expect(problemsOf(() => lab(env))).toEqual([name]);
      }
    });

    it('a missing one for the chosen runner is a ConfigError naming it, and no value is echoed', () => {
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'local' }))).toEqual(['TOWNWISE_LAB_API_URL']);
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'azure', TOWNWISE_LAB_API_URL: 'http://localhost:8080', ...CALLER }))).toEqual(['TOWNWISE_LAB_JOB_ID']);
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'azure' }))).toEqual([
        'TOWNWISE_LAB_JOB_ID', 'TOWNWISE_LAB_AUDIENCE', 'TOWNWISE_LAB_CALLER_ID', 'TOWNWISE_LAB_TENANT_ID',
      ]);
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'sentinel-runner' }))).toEqual(['TOWNWISE_LAB_RUNNER']);
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'azure', TOWNWISE_LAB_JOB_ID: '/subscriptions/sentinel/jobs/x' }))).toEqual(['TOWNWISE_LAB_JOB_ID']);
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'http://localhost:8080/sentinel-path' })))
        .toEqual(['TOWNWISE_LAB_API_URL']);
      expect(problemsOf(() => lab({ TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'ftp://sentinel.example.test' }))).toEqual(['TOWNWISE_LAB_API_URL']);
    });
  });
});
