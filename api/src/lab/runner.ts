// How a calibration's job starts (forecast lab design call 2). LabRunner is the port the service calls; every runner
// starts the same CLI (python -m townwise_lab job), which fetches its input from and posts its result to the callback
// (lab/callback.ts), so each mode runs the production path.
// - azure: the API's managed identity reads the Container Apps job (its template carries the image and
//   TOWNWISE_LAB_API_URL) and starts one execution of it with TOWNWISE_LAB_CALIBRATION_ID and TOWNWISE_LAB_TOKEN added
//   to the container's environment. No figure goes into the start request: the job reads its input over the callback.
// - local: spawns uv in modeling/lab with PATH, HOME and the four TOWNWISE_LAB_ variables only, output ignored.
// Nothing here logs. A failure is a LabStartError with a code (and an HTTP status for upstream_status), never a response
// body, a token or a command's output.
import { spawn as nodeSpawn } from 'node:child_process';

import { z } from 'zod';

import { execFileRunner, type AzureTokenSource, type CommandRunner, type FetchLike } from '../azure-identity.ts';

export interface LabJob {
  readonly calibrationId: string;
  /** The calibration's bearer token for the callback; only its sha256 is stored. */
  readonly token: string;
}

export interface LabStart {
  /** The image the job runs, by digest, when the runner knows it (azure). */
  readonly imageDigest: string | null;
  /** The commit the job runs, when the runner knows it (local). */
  readonly codeVersion: string | null;
}

export interface LabRunner {
  /** Starts the calibration's job. Throws LabStartError. */
  start(job: LabJob): Promise<LabStart>;
}

export type LabStartFailure = 'token' | 'upstream_status' | 'timeout' | 'bad_response' | 'spawn';

export class LabStartError extends Error {
  readonly code: LabStartFailure;
  /** The management API's HTTP status, for upstream_status; null when no answer came. */
  readonly status: number | null;

  constructor(code: LabStartFailure, opts?: { status?: number }) {
    super('The calibration job could not start');
    this.name = 'LabStartError';
    this.code = code;
    this.status = opts?.status ?? null;
  }
}

/** The job's environment (modeling/lab/townwise_lab/job.py reads these names). */
export const LAB_ENV = {
  apiUrl: 'TOWNWISE_LAB_API_URL',
  calibrationId: 'TOWNWISE_LAB_CALIBRATION_ID',
  token: 'TOWNWISE_LAB_TOKEN',
  codeVersion: 'TOWNWISE_LAB_CODE_VERSION',
} as const;

export const ARM_ENDPOINT = 'https://management.azure.com';
/** The token resource for Azure Resource Manager. */
export const ARM_RESOURCE = 'https://management.azure.com/';
/** The Microsoft.App API version infra/terraform/production/jobs.tf manages the jobs with. */
export const JOBS_API_VERSION = '2025-07-01';
/** One management request, from the request to the last byte of the answer. */
export const LAB_START_TIMEOUT_MS = 15_000;

const envVar = z.looseObject({ name: z.string().min(1) });
const container = z.looseObject({
  name: z.string().min(1),
  image: z.string().min(1),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  env: z.array(envVar).optional(),
  resources: z.looseObject({}).optional(),
});
/** The lab job has one container (lab.tf); anything else is not the job this runner was given. */
const jobSchema = z.looseObject({
  properties: z.looseObject({ template: z.looseObject({ containers: z.array(container).length(1) }) }),
});

const DIGEST = /@(sha256:[0-9a-f]{64})$/;

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * The production runner. `jobId` is the job's resource id (/subscriptions/.../providers/Microsoft.App/jobs/<name>);
 * the identity needs Microsoft.App/jobs/read and Microsoft.App/jobs/start/action on it ("Townwise lab starter").
 */
export function createAzureLabRunner(deps: {
  tokens: AzureTokenSource;
  jobId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): LabRunner {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? LAB_START_TIMEOUT_MS;
  const jobUrl = `${ARM_ENDPOINT}${deps.jobId}`;

  const send = async (url: string, token: string, body?: unknown): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw isTimeout(err) ? new LabStartError('timeout') : new LabStartError('upstream_status');
    }
    if (!res.ok) {
      if (res.body !== null) await res.body.cancel().catch(() => undefined);
      // Any refusal drops the cached token, so a stale or revoked one never sticks (as mail/acs.ts does).
      deps.tokens.invalidate(ARM_RESOURCE);
      throw new LabStartError('upstream_status', { status: res.status });
    }
    return res;
  };

  return {
    async start(job) {
      let token: string;
      try {
        token = (await deps.tokens.getToken(ARM_RESOURCE)).token;
      } catch {
        throw new LabStartError('token');
      }
      const read = await send(`${jobUrl}?api-version=${JOBS_API_VERSION}`, token);
      let raw: unknown;
      try {
        raw = await read.json();
      } catch (err) {
        throw new LabStartError(isTimeout(err) ? 'timeout' : 'bad_response');
      }
      const parsed = jobSchema.safeParse(raw);
      const template = parsed.success ? parsed.data.properties.template.containers[0] : undefined;
      if (template === undefined) throw new LabStartError('bad_response');
      const added = new Set<string>([LAB_ENV.calibrationId, LAB_ENV.token]);
      const env = [
        ...(template.env ?? []).filter((entry) => !added.has(entry.name)),
        { name: LAB_ENV.calibrationId, value: job.calibrationId },
        { name: LAB_ENV.token, value: job.token },
      ];
      // A start request's template replaces the job's containers for that execution, so it carries the whole container.
      const started = await send(`${jobUrl}/start?api-version=${JOBS_API_VERSION}`, token, {
        containers: [{
          name: template.name,
          image: template.image,
          ...(template.command === undefined ? {} : { command: template.command }),
          ...(template.args === undefined ? {} : { args: template.args }),
          ...(template.resources === undefined ? {} : { resources: template.resources }),
          env,
        }],
      });
      if (started.body !== null) await started.body.cancel().catch(() => undefined);
      return { imageDigest: DIGEST.exec(template.image)?.[1] ?? null, codeVersion: null };
    },
  };
}

/** What the local runner needs of a started child process (node:child_process's ChildProcess has it). */
export interface SpawnedJob {
  once(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
}

export type Spawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: 'ignore' },
) => SpawnedJob;

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Development: runs `uv run --frozen --project <projectDir> python -m townwise_lab job` in `projectDir`, with only
 * PATH and HOME (`path` and `home`, which main.ts passes) and the four TOWNWISE_LAB_ variables in its environment, and
 * the code version from `git rev-parse HEAD`. Its output is ignored, so nothing it prints reaches the API's logs. It
 * resolves once the process has started; a job that then fails is timed out like any other.
 */
export function createLocalLabRunner(deps: {
  projectDir: string;
  apiUrl: string;
  path: string;
  home: string;
  spawn?: Spawner;
  git?: CommandRunner;
}): LabRunner {
  const spawn: Spawner = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const git = deps.git ?? execFileRunner;
  return {
    async start(job) {
      let codeVersion: string;
      try {
        codeVersion = (await git('git', ['-C', deps.projectDir, 'rev-parse', 'HEAD'])).trim();
      } catch {
        throw new LabStartError('spawn');
      }
      if (!COMMIT.test(codeVersion)) throw new LabStartError('spawn');
      const env: Record<string, string> = {
        PATH: deps.path,
        HOME: deps.home,
        [LAB_ENV.apiUrl]: deps.apiUrl,
        [LAB_ENV.calibrationId]: job.calibrationId,
        [LAB_ENV.token]: job.token,
        [LAB_ENV.codeVersion]: codeVersion,
      };
      const child = spawn('uv', ['run', '--frozen', '--project', deps.projectDir, 'python', '-m', 'townwise_lab', 'job'], {
        cwd: deps.projectDir, env, stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        // Kept for the process's life: a later error is then ignored rather than thrown as an unhandled 'error' event.
        child.on('error', () => { reject(new LabStartError('spawn')); });
      });
      child.unref();
      return { imageDigest: null, codeVersion };
    },
  };
}
