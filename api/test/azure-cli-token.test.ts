// Local tokens from the developer's Azure CLI sign-in (api/src/azure-identity.ts), over a fake command runner, and
// the rule main.ts follows to choose them over the managed identity.
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  AZURE_CLI_FAILURE, createAzureCliTokenSource, execFileRunner, TOKEN_REFRESH_MARGIN_MS, usesAzureCli,
  type CommandRunner,
} from '../src/azure-identity.ts';

const RESOURCE = 'https://communication.azure.com';
const START = Date.parse('2026-06-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const SENTINEL = 'sentinel-cli-output';

interface Run { file: string; args: readonly string[] }

function fakeRunner(answer: (run: Run, n: number) => Promise<string> | string): { run: CommandRunner; runs: Run[] } {
  const runs: Run[] = [];
  return {
    runs,
    run: (file, args) => {
      const call = { file, args };
      runs.push(call);
      try {
        return Promise.resolve(answer(call, runs.length));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

/** What `az account get-access-token -o json` prints (Azure CLI 2.86). */
function cliAnswer(token: string, expiresOnMs: number): string {
  return JSON.stringify({
    accessToken: token,
    expiresOn: '2026-06-01 13:00:00.000000',
    expires_on: Math.floor(expiresOnMs / 1000),
    subscription: '00000000-0000-0000-0000-000000000000',
    tenant: '00000000-0000-0000-0000-000000000000',
    tokenType: 'Bearer',
  });
}

function clock(): { now: () => Date; set: (ms: number) => void } {
  let current = START;
  return { now: () => new Date(current), set: (ms) => { current = ms; } };
}

describe('createAzureCliTokenSource', () => {
  it('runs az account get-access-token for the resource, as an argument list, and reads accessToken and expires_on', async () => {
    const fake = fakeRunner(() => cliAnswer('token-one', START + HOUR));
    const tokens = createAzureCliTokenSource({ now: clock().now, run: fake.run });
    expect(await tokens.getToken(RESOURCE)).toEqual({ token: 'token-one', expiresOnTimestamp: START + HOUR });
    expect(fake.runs).toEqual([{ file: 'az', args: ['account', 'get-access-token', '--resource', RESOURCE, '-o', 'json'] }]);
  });

  it('reads expiresOn as local time when expires_on is absent (older Azure CLI)', async () => {
    const fake = fakeRunner(() => JSON.stringify({ accessToken: 'token-old', expiresOn: '2026-06-01 13:30:15.123456' }));
    const tokens = createAzureCliTokenSource({ now: clock().now, run: fake.run });
    expect((await tokens.getToken(RESOURCE)).expiresOnTimestamp).toBe(new Date(2026, 5, 1, 13, 30, 15).getTime());
  });

  it('reuses a token until five minutes before it expires, then runs az again', async () => {
    const time = clock();
    const fake = fakeRunner((_, n) => cliAnswer(`token-${String(n)}`, START + HOUR * n));
    const tokens = createAzureCliTokenSource({ now: time.now, run: fake.run });
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-1');
    time.set(START + HOUR - TOKEN_REFRESH_MARGIN_MS - 1);
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-1');
    expect(fake.runs).toHaveLength(1);
    time.set(START + HOUR - TOKEN_REFRESH_MARGIN_MS);
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-2');
    expect(fake.runs).toHaveLength(2);
  });

  it('keeps one cache per resource, and invalidate drops it', async () => {
    const fake = fakeRunner((run, n) => cliAnswer(`${String(n)} for ${run.args[3] ?? ''}`, START + HOUR));
    const tokens = createAzureCliTokenSource({ now: clock().now, run: fake.run });
    expect((await tokens.getToken(RESOURCE)).token).toBe(`1 for ${RESOURCE}`);
    expect((await tokens.getToken('https://storage.azure.com')).token).toBe('2 for https://storage.azure.com');
    expect((await tokens.getToken(RESOURCE)).token).toBe(`1 for ${RESOURCE}`);
    tokens.invalidate(RESOURCE);
    expect((await tokens.getToken(RESOURCE)).token).toBe(`3 for ${RESOURCE}`);
  });

  it('fails with the fixed message and nothing else on a failed run or an answer with no token, and caches no failure', async () => {
    // A non-zero exit from execFile: the error carries the command's stdout and stderr.
    const exit = Object.assign(new Error(`Command failed: az account get-access-token\n${SENTINEL} stderr`), {
      code: 1, stdout: `${SENTINEL} stdout`, stderr: `${SENTINEL} stderr`,
    });
    const answers: (() => Promise<string> | string)[] = [
      () => Promise.reject(exit),
      () => `not json ${SENTINEL}`,
      () => JSON.stringify({ token: SENTINEL }),
      () => JSON.stringify({ accessToken: '', expires_on: 1 }),
      () => JSON.stringify({ accessToken: SENTINEL }),
      () => JSON.stringify({ accessToken: SENTINEL, expiresOn: 'soon' }),
      () => JSON.stringify({ accessToken: SENTINEL, expires_on: SENTINEL }),
      () => cliAnswer('after failures', START + HOUR),
    ];
    const fake = fakeRunner((_, n) => answers[n - 1]?.() ?? '');
    const tokens = createAzureCliTokenSource({ now: clock().now, run: fake.run });
    for (let i = 0; i < answers.length - 1; i += 1) {
      const err: unknown = await tokens.getToken(RESOURCE).then(() => expect.unreachable(), (failure: unknown) => failure);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(AZURE_CLI_FAILURE);
      expect((err as Error).cause).toBeUndefined();
      expect(inspect(err, { showHidden: true, depth: 5 })).not.toContain(SENTINEL);
    }
    expect((await tokens.getToken(RESOURCE)).token).toBe('after failures');
    expect(fake.runs).toHaveLength(answers.length);
  });
});

describe('execFileRunner', () => {
  it('passes each argument as it is, with no shell to expand it, and resolves with stdout', async () => {
    const literal = '$(echo expanded) `echo expanded` ; echo expanded | cat && "quoted" *';
    expect(await execFileRunner(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal])).toBe(literal);
  });

  it('rejects on a non-zero exit', async () => {
    await expect(execFileRunner(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow();
  });
});

describe('usesAzureCli', () => {
  it('never in production, so a missing managed identity still refuses boot there', () => {
    expect(usesAzureCli({ IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined }, 'production')).toBe(false);
  });

  it('outside production, only while IDENTITY_ENDPOINT and IDENTITY_HEADER are both unset', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(usesAzureCli({ IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined }, nodeEnv)).toBe(true);
      expect(usesAzureCli({ IDENTITY_ENDPOINT: ' ', IDENTITY_HEADER: '' }, nodeEnv)).toBe(true);
      expect(usesAzureCli({ IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token', IDENTITY_HEADER: undefined }, nodeEnv)).toBe(false);
      expect(usesAzureCli({ IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: 'header' }, nodeEnv)).toBe(false);
    }
  });
});
