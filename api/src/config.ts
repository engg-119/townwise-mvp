import { ConfigError, type ServerConfig } from '@ckeith26/server-core';
import { z } from 'zod';

import { normalizeEmail } from './normalize-email.ts';

const MAX_STAFF = 20;
const ACS_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.communication\.azure\.com$/;
const LAB_JOB_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[\w.()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z0-9-]{2,32}$/i;

/** Spread into the one loadEnv call in main.ts. Messages never include the values. */
export const configSchema = z.object({
  TOWNWISE_SUPERADMIN_EMAILS: z.string().default('').transform((raw, ctx): readonly string[] => {
    const emails = new Set<string>();
    for (const part of raw.split(',')) {
      if (part.trim() === '') continue;
      const email = normalizeEmail(part);
      if (email === null) {
        ctx.addIssue({ code: 'custom', message: 'expected comma-separated email addresses' });
        return z.NEVER;
      }
      emails.add(email);
    }
    if (emails.size > MAX_STAFF) {
      ctx.addIssue({ code: 'custom', message: `at most ${MAX_STAFF} addresses` });
      return z.NEVER;
    }
    return [...emails];
  }),
  /**
   * Whether staff must pass two-step sign-in (spec Section 2, steps 2.1 to 2.3): `required`, or `off` to let a staff
   * address in with no authenticator. Absent, it is `off` in development and `required` otherwise; production refuses
   * `off`.
   */
  TOWNWISE_STAFF_TWO_STEP: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['required', 'off']).optional()),
  /** The tuning chat's monthly spend limit per organization, in US dollars (docs/portal/tuning-chat.md section 5). */
  TOWNWISE_CHAT_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(20),
  /** The Communication Services endpoint, https://<resource>.communication.azure.com. Absent turns email off (spec D14). */
  EMAIL_ENDPOINT: z.url({ protocol: /^https$/, hostname: ACS_HOST }).optional(),
  /** The From address, a sender username on the verified domain. Required with EMAIL_ENDPOINT. */
  EMAIL_SENDER: z.email().optional(),
  /** Reply-To on every Townwise email. Absent, no Reply-To is set and the footer doesn't offer replies. */
  TOWNWISE_EMAIL_REPLY_TO: z.email().optional(),
  /** The web app's origin, for links in emails. */
  TOWNWISE_WEB_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:8081'),
  /** The client files storage account (spec 11A). Absent or empty turns stored files off (503 files_unavailable). */
  FILES_BLOB_ACCOUNT_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
  /**
   * The file reader's AI column step's monthly spend limit per organization, in US dollars (spec 11A); 0 turns the step
   * off. Apart from the tuning chat's budget.
   */
  TOWNWISE_FILES_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(5),
  /** Development and tests only: Azurite's connection string, used instead of the managed identity. */
  FILES_AZURITE_CONNECTION_STRING: z.preprocess((value) => (value === '' ? undefined : value), z.string().optional()),
  /**
   * How the forecast lab runs a calibration's job: `off` (503 lab_unavailable), `local` (uv in TOWNWISE_LAB_PROJECT_DIR)
   * or `azure` (the Container Apps job TOWNWISE_LAB_JOB_ID).
   */
  TOWNWISE_LAB_RUNNER: z.enum(['off', 'local', 'azure']).default('off'),
  /** `local` only: the origin a local job calls back, this API's (http://localhost:8080). */
  TOWNWISE_LAB_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** `azure` only: the job's resource id, /subscriptions/<id>/resourceGroups/<name>/providers/Microsoft.App/jobs/<name>. */
  TOWNWISE_LAB_JOB_ID: z.string().regex(LAB_JOB_ID, { message: 'expected a Microsoft.App/jobs resource id' }).optional(),
  /** `local` only: the lab's uv project, relative to the API's working directory. */
  TOWNWISE_LAB_PROJECT_DIR: z.string().default('../modeling/lab'),
  /** `azure` only: the lab callback app's client id, the audience of the lab job's token (bootstrap's lab_callback_client_id). */
  TOWNWISE_LAB_AUDIENCE: z.guid({ message: 'expected a GUID' }).optional(),
  /** `azure` only: the lab identity's principal (object) id, the one caller the callback accepts. */
  TOWNWISE_LAB_CALLER_ID: z.guid({ message: 'expected a GUID' }).optional(),
  /** `azure` only: the Entra tenant the lab job's token comes from. */
  TOWNWISE_LAB_TENANT_ID: z.guid({ message: 'expected a GUID' }).optional(),
});

export type TownwiseConfig = z.infer<typeof configSchema>;

export interface ResolvedTownwiseConfig {
  readonly superadminEmails: ReadonlySet<string>;
  /** False only outside production with TOWNWISE_STAFF_TWO_STEP off: staff then need no codes. */
  readonly staffTwoStep: boolean;
  readonly chatMonthlyBudgetUsd: number;
  readonly filesMonthlyBudgetUsd: number;
  /** Null while email is off. `endpoint` is a bare origin. */
  readonly email: { readonly endpoint: string; readonly sender: string } | null;
  readonly emailReplyTo: string | null;
  /** A bare origin, with no trailing slash. */
  readonly webUrl: string;
}

/** The URL's origin, or null when it has a path, query, fragment or credentials. */
function bareOrigin(value: string): string | null {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null;
  return url.origin;
}

/** Where stored files live, or null while they are off. */
export type FilesBackend =
  | { readonly kind: 'azure'; readonly accountUrl: string }
  | { readonly kind: 'azurite'; readonly connectionString: string };

/** Production refuses Azurite and any account URL that is not HTTPS. */
export function filesBackendOf(
  config: Pick<TownwiseConfig, 'FILES_BLOB_ACCOUNT_URL' | 'FILES_AZURITE_CONNECTION_STRING'> & Pick<ServerConfig, 'NODE_ENV'>,
): FilesBackend | null {
  const accountUrl = config.FILES_BLOB_ACCOUNT_URL;
  const azurite = config.FILES_AZURITE_CONNECTION_STRING;
  if (config.NODE_ENV === 'production') {
    if (azurite !== undefined) throw new ConfigError('FILES_AZURITE_CONNECTION_STRING', 'is for development only');
    if (accountUrl !== undefined && !accountUrl.startsWith('https://')) {
      throw new ConfigError('FILES_BLOB_ACCOUNT_URL', 'production requires an https URL');
    }
  }
  if (accountUrl === undefined) return null;
  return azurite === undefined ? { kind: 'azure', accountUrl } : { kind: 'azurite', connectionString: azurite };
}

/** Who the callback accepts in Azure: the lab identity's Entra token for the lab callback app (lab/caller.ts). */
export interface LabCallerConfig {
  readonly audience: string;
  readonly objectId: string;
  readonly tenantId: string;
}

/** How the forecast lab starts a job and who may call back (main.ts builds both from it), or null while the lab is off. */
export type LabRunnerConfig =
  | { readonly kind: 'local'; readonly apiUrl: string; readonly projectDir: string }
  | { readonly kind: 'azure'; readonly jobId: string; readonly caller: LabCallerConfig };

type LabKeys =
  | 'TOWNWISE_LAB_RUNNER' | 'TOWNWISE_LAB_API_URL' | 'TOWNWISE_LAB_JOB_ID' | 'TOWNWISE_LAB_PROJECT_DIR'
  | 'TOWNWISE_LAB_AUDIENCE' | 'TOWNWISE_LAB_CALLER_ID' | 'TOWNWISE_LAB_TENANT_ID';

/**
 * A runner missing a variable refuses boot, naming each missing one, and so does `local` in production (it is for
 * development).
 */
export function labRunnerOf(config: Pick<TownwiseConfig, LabKeys> & Partial<Pick<ServerConfig, 'NODE_ENV'>>): LabRunnerConfig | null {
  switch (config.TOWNWISE_LAB_RUNNER) {
    case 'off':
      return null;
    case 'local': {
      if (config.NODE_ENV === 'production') throw new ConfigError('TOWNWISE_LAB_RUNNER', 'local is for development only');
      if (config.TOWNWISE_LAB_API_URL === undefined) throw new ConfigError('TOWNWISE_LAB_API_URL', 'required with TOWNWISE_LAB_RUNNER=local');
      const apiUrl = bareOrigin(config.TOWNWISE_LAB_API_URL);
      if (apiUrl === null) throw new ConfigError('TOWNWISE_LAB_API_URL', 'expected a bare origin, with no path or query');
      return { kind: 'local', apiUrl, projectDir: config.TOWNWISE_LAB_PROJECT_DIR };
    }
    case 'azure': {
      const {
        TOWNWISE_LAB_JOB_ID: jobId, TOWNWISE_LAB_AUDIENCE: audience, TOWNWISE_LAB_CALLER_ID: objectId, TOWNWISE_LAB_TENANT_ID: tenantId,
      } = config;
      if (jobId === undefined || audience === undefined || objectId === undefined || tenantId === undefined) {
        const required = { TOWNWISE_LAB_JOB_ID: jobId, TOWNWISE_LAB_AUDIENCE: audience, TOWNWISE_LAB_CALLER_ID: objectId, TOWNWISE_LAB_TENANT_ID: tenantId };
        throw new ConfigError(Object.entries(required).filter(([, value]) => value === undefined)
          .map(([variable]) => ({ variable, problem: 'required with TOWNWISE_LAB_RUNNER=azure' })));
      }
      return { kind: 'azure', jobId, caller: { audience, objectId, tenantId } };
    }
  }
}

/**
 * Production refuses an empty staff list, staff without two-step sign-in, email with an http web URL, and Azurite for
 * stored files; email needs both its variables (spec Section 18). The lab's variables are labRunnerOf's.
 */
export function resolveTownwiseConfig(
  config: Omit<TownwiseConfig, LabKeys> & Pick<ServerConfig, 'NODE_ENV'>,
): ResolvedTownwiseConfig {
  if (config.NODE_ENV === 'production' && config.TOWNWISE_SUPERADMIN_EMAILS.length === 0) {
    throw new ConfigError('TOWNWISE_SUPERADMIN_EMAILS', 'production requires at least one staff address');
  }
  const staffTwoStep = config.TOWNWISE_STAFF_TWO_STEP ?? (config.NODE_ENV === 'development' ? 'off' : 'required');
  if (config.NODE_ENV === 'production' && staffTwoStep === 'off') {
    throw new ConfigError('TOWNWISE_STAFF_TWO_STEP', 'production requires two-step sign-in for staff');
  }
  if ((config.EMAIL_ENDPOINT === undefined) !== (config.EMAIL_SENDER === undefined)) {
    throw new ConfigError(config.EMAIL_ENDPOINT === undefined ? 'EMAIL_ENDPOINT' : 'EMAIL_SENDER', 'set EMAIL_ENDPOINT and EMAIL_SENDER together');
  }
  const endpoint = config.EMAIL_ENDPOINT === undefined ? null : bareOrigin(config.EMAIL_ENDPOINT);
  if (config.EMAIL_ENDPOINT !== undefined && endpoint === null) {
    throw new ConfigError('EMAIL_ENDPOINT', 'expected a bare origin, with no path or query');
  }
  const webUrl = bareOrigin(config.TOWNWISE_WEB_URL);
  if (webUrl === null) throw new ConfigError('TOWNWISE_WEB_URL', 'expected a bare origin, with no path or query');
  if (config.NODE_ENV === 'production' && endpoint !== null && !webUrl.startsWith('https:')) {
    throw new ConfigError('TOWNWISE_WEB_URL', 'production email requires https');
  }
  filesBackendOf(config);
  return {
    superadminEmails: new Set(config.TOWNWISE_SUPERADMIN_EMAILS),
    staffTwoStep: staffTwoStep === 'required',
    chatMonthlyBudgetUsd: config.TOWNWISE_CHAT_MONTHLY_BUDGET_USD,
    filesMonthlyBudgetUsd: config.TOWNWISE_FILES_MONTHLY_BUDGET_USD,
    email: endpoint === null || config.EMAIL_SENDER === undefined ? null : { endpoint, sender: config.EMAIL_SENDER },
    emailReplyTo: config.TOWNWISE_EMAIL_REPLY_TO ?? null,
    webUrl,
  };
}
