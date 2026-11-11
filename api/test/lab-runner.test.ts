// The forecast lab's runners: the Azure one over a fake fetch and token source, the local one over a fake spawn and
// git. A start hands the job its calibration id and no secret (the job signs in as the lab identity; locally it gets
// the API process's secret). Failures carry a code and never a response body, a token or a command's output.
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { AzureIdentityError, type AzureTokenSource, type FetchLike } from '../src/azure-identity.ts';
import {
  ARM_RESOURCE, createAzureLabRunner, createLocalLabRunner, JOBS_API_VERSION, LabStartError, type SpawnedJob, type Spawner,
} from '../src/lab/runner.ts';

const JOB_ID = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-lab';
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const JOB = { calibrationId: 'c1'.repeat(12) };
/** The local API process's secret (main.ts makes one per process). */
const SECRET = 'S'.repeat(43);
const SENTINEL = 'sentinel-upstream-body';

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

function tokens(opts?: { fail?: boolean }): AzureTokenSource & { invalidated: string[]; asked: string[] } {
  const invalidated: string[] = [];
  const asked: string[] = [];
  return {
    invalidated, asked,
    getToken: (resource) => {
      asked.push(resource);
      if (opts?.fail === true) return Promise.reject(new AzureIdentityError('upstream_status', { status: 400 }));
      return Promise.resolve({ token: 'arm-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    },
    invalidate: (resource) => { invalidated.push(resource); },
  };
}

function jobBody(image = `crtownwise.azurecr.io/townwise-lab@${DIGEST}`): unknown {
  return {
    id: JOB_ID, name: 'caj-townwise-lab',
    properties: {
      template: {
        containers: [{
          name: 'lab', image, resources: { cpu: 1, memory: '2Gi' },
          // As lab.tf sets it, plus a calibration id a start must replace.
          env: [
            { name: 'TOWNWISE_LAB_API_URL', value: 'https://api.example.test' },
            { name: 'AZURE_CLIENT_ID', value: '00000000-0000-0000-0000-0000000001d1' },
            { name: 'TOWNWISE_LAB_TOKEN_RESOURCE', value: 'api://22222222-2222-4222-8222-222222222222' },
            { name: 'TOWNWISE_LAB_CALIBRATION_ID', value: 'stale' },
          ],
          probes: [],
        }],
        initContainers: null,
      },
      configuration: { triggerType: 'Manual' },
    },
  };
}

function fakeFetch(answers: ((sent: Sent) => Response | Promise<Response>)[]): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const entry: Sent = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    sent.push(entry);
    const answer = answers[sent.length - 1];
    if (answer === undefined) throw new Error('unexpected request');
    return answer(entry);
  };
  return { fetch, sent };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function failureOf(run: Promise<unknown>): Promise<LabStartError> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(LabStartError);
    return err as LabStartError;
  }
  return expect.unreachable();
}

describe('azure lab runner', () => {
  it('azure: reads the job, starts it with the template container plus the calibration id, and returns the image digest', async () => {
    const source = tokens();
    const { fetch, sent } = fakeFetch([() => json(jobBody()), () => json({ id: `${JOB_ID}/executions/caj-townwise-lab-abc`, name: 'caj-townwise-lab-abc' }, 202)]);
    const runner = createAzureLabRunner({ tokens: source, jobId: JOB_ID, fetch });
    expect(await runner.start(JOB)).toEqual({ imageDigest: DIGEST, codeVersion: null });
    expect(source.asked).toEqual([ARM_RESOURCE]);
    expect(sent.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: `https://management.azure.com${JOB_ID}?api-version=${JOBS_API_VERSION}` },
      { method: 'POST', url: `https://management.azure.com${JOB_ID}/start?api-version=${JOBS_API_VERSION}` },
    ]);
    for (const request of sent) expect(request.headers.authorization).toBe('Bearer arm-token');
    expect(sent[1]?.headers['content-type']).toBe('application/json');
    // The template's one container with its image, resources and environment, the calibration id replaced; nothing
    // else, and no secret: the job signs in as the lab identity.
    expect(sent[1]?.body).toEqual({
      containers: [{
        name: 'lab', image: `crtownwise.azurecr.io/townwise-lab@${DIGEST}`, resources: { cpu: 1, memory: '2Gi' },
        env: [
          { name: 'TOWNWISE_LAB_API_URL', value: 'https://api.example.test' },
          { name: 'AZURE_CLIENT_ID', value: '00000000-0000-0000-0000-0000000001d1' },
          { name: 'TOWNWISE_LAB_TOKEN_RESOURCE', value: 'api://22222222-2222-4222-8222-222222222222' },
          { name: 'TOWNWISE_LAB_CALIBRATION_ID', value: JOB.calibrationId },
        ],
      }],
    });
    expect(JSON.stringify(sent[1]?.body)).not.toContain('"TOWNWISE_LAB_TOKEN"');
  });

  it('answers a null digest for an image named by tag', async () => {
    const { fetch } = fakeFetch([() => json(jobBody('crtownwise.azurecr.io/townwise-lab:latest')), () => new Response(null, { status: 202 })]);
    expect(await createAzureLabRunner({ tokens: tokens(), jobId: JOB_ID, fetch }).start(JOB)).toEqual({ imageDigest: null, codeVersion: null });
  });

  it('azure: a refused token, a non-2xx or a timeout throws LabStartError with its code and no response body in it', async () => {
    const plain = (err: LabStartError): string => `${String(err)} ${err.message} ${JSON.stringify(err)} ${String(err.stack)}`;

    const refused = await failureOf(createAzureLabRunner({ tokens: tokens({ fail: true }), jobId: JOB_ID, fetch: fakeFetch([]).fetch }).start(JOB));
    expect({ code: refused.code, status: refused.status }).toEqual({ code: 'token', status: null });

    const source = tokens();
    const forbidden = await failureOf(createAzureLabRunner({
      tokens: source, jobId: JOB_ID, fetch: fakeFetch([() => new Response(SENTINEL, { status: 401 })]).fetch,
    }).start(JOB));
    expect({ code: forbidden.code, status: forbidden.status }).toEqual({ code: 'upstream_status', status: 401 });
    expect(source.invalidated).toEqual([ARM_RESOURCE]);
    expect(plain(forbidden)).not.toContain(SENTINEL);

    const refusing = tokens();
    const startRefused = await failureOf(createAzureLabRunner({
      tokens: refusing, jobId: JOB_ID, fetch: fakeFetch([() => json(jobBody()), () => new Response(SENTINEL, { status: 409 })]).fetch,
    }).start(JOB));
    expect({ code: startRefused.code, status: startRefused.status }).toEqual({ code: 'upstream_status', status: 409 });
    expect(refusing.invalidated).toEqual([ARM_RESOURCE]);
    expect(plain(startRefused)).not.toContain(SENTINEL);

    const timedOut = await failureOf(createAzureLabRunner({
      tokens: tokens(), jobId: JOB_ID, timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error); });
      }),
    }).start(JOB));
    expect(timedOut.code).toBe('timeout');

    const unreadable = await failureOf(createAzureLabRunner({
      tokens: tokens(), jobId: JOB_ID, fetch: fakeFetch([() => new Response(`not json ${SENTINEL}`, { status: 200 })]).fetch,
    }).start(JOB));
    expect(unreadable.code).toBe('bad_response');
    expect(plain(unreadable)).not.toContain(SENTINEL);

    const twoContainers = { properties: { template: { containers: [{ name: 'a', image: 'x' }, { name: 'b', image: 'y' }] } } };
    const unexpected = await failureOf(createAzureLabRunner({ tokens: tokens(), jobId: JOB_ID, fetch: fakeFetch([() => json(twoContainers)]).fetch }).start(JOB));
    expect(unexpected.code).toBe('bad_response');
  });
});

class FakeChild extends EventEmitter implements SpawnedJob {
  unrefed = false;
  unref(): void { this.unrefed = true; }
}

function fakeSpawn(behaviour: 'spawn' | 'error'): { spawn: Spawner; calls: { command: string; args: string[]; options: Parameters<Spawner>[2] }[]; child: FakeChild } {
  const child = new FakeChild();
  const calls: { command: string; args: string[]; options: Parameters<Spawner>[2] }[] = [];
  const spawn: Spawner = (command, args, options) => {
    calls.push({ command, args, options });
    setImmediate(() => {
      if (behaviour === 'spawn') child.emit('spawn');
      else child.emit('error', Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }));
    });
    return child;
  };
  return { spawn, calls, child };
}

const COMMIT = 'f'.repeat(40);

describe('local lab runner', () => {
  it('local: spawns uv with only PATH, HOME and the four TOWNWISE_LAB_ variables (the token is the process secret), stdio ignored', async () => {
    const { spawn, calls, child } = fakeSpawn('spawn');
    const gitCalls: { file: string; args: readonly string[] }[] = [];
    const runner = createLocalLabRunner({
      projectDir: '/repo/modeling/lab', apiUrl: 'http://localhost:8080', token: SECRET, path: '/usr/bin:/bin', home: '/home/dev', spawn,
      git: (file, args) => { gitCalls.push({ file, args }); return Promise.resolve(`${COMMIT}\n`); },
    });
    expect(await runner.start(JOB)).toEqual({ imageDigest: null, codeVersion: COMMIT });
    expect(gitCalls).toEqual([{ file: 'git', args: ['-C', '/repo/modeling/lab', 'rev-parse', 'HEAD'] }]);
    expect(calls).toEqual([{
      command: 'uv',
      args: ['run', '--frozen', '--project', '/repo/modeling/lab', 'python', '-m', 'townwise_lab', 'job'],
      options: {
        cwd: '/repo/modeling/lab', stdio: 'ignore',
        env: {
          PATH: '/usr/bin:/bin', HOME: '/home/dev', TOWNWISE_LAB_API_URL: 'http://localhost:8080',
          TOWNWISE_LAB_CALIBRATION_ID: JOB.calibrationId, TOWNWISE_LAB_TOKEN: SECRET, TOWNWISE_LAB_CODE_VERSION: COMMIT,
        },
      },
    }]);
    expect(child.unrefed).toBe(true);
    // A later error is ignored, not thrown as an unhandled 'error' event.
    expect(() => child.emit('error', new Error('later'))).not.toThrow();
  });

  it('local: uv that will not start, or no git commit, throws LabStartError spawn with nothing of either', async () => {
    const missing = await failureOf(createLocalLabRunner({
      projectDir: '/repo/modeling/lab', apiUrl: 'http://localhost:8080', token: SECRET, path: '', home: '', spawn: fakeSpawn('error').spawn,
      git: () => Promise.resolve(COMMIT),
    }).start(JOB));
    expect(missing.code).toBe('spawn');
    expect(missing.message).not.toContain('ENOENT');

    const { spawn, calls } = fakeSpawn('spawn');
    for (const git of [() => Promise.reject(new Error(`fatal: ${SENTINEL}`)), () => Promise.resolve('not a commit')]) {
      const failed = await failureOf(createLocalLabRunner({ projectDir: '/repo', apiUrl: 'http://localhost:8080', token: SECRET, path: '', home: '', spawn, git }).start(JOB));
      expect(failed.code).toBe('spawn');
      expect(failed.message).not.toContain(SENTINEL);
    }
    expect(calls).toEqual([]);
  });
});
