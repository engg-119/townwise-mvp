import { ConfigError, type ServerConfig } from '@ckeith26/server-core';
import { z } from 'zod';

import { normalizeEmail } from './normalize-email.ts';

const MAX_STAFF = 20;

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
  /** The tuning chat's monthly spend limit per organization, in US dollars (docs/portal/tuning-chat.md section 5). */
  TOWNWISE_CHAT_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(20),
  /** The client files storage account (spec 11A). Absent or empty turns stored files off (503 files_unavailable). */
  FILES_BLOB_ACCOUNT_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
  /** Development and tests only: Azurite's connection string, used instead of the managed identity. */
  FILES_AZURITE_CONNECTION_STRING: z.preprocess((value) => (value === '' ? undefined : value), z.string().optional()),
});

export type TownwiseConfig = z.infer<typeof configSchema>;

export interface ResolvedTownwiseConfig {
  readonly superadminEmails: ReadonlySet<string>;
  readonly chatMonthlyBudgetUsd: number;
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

/** Production refuses an empty staff list (spec Section 18), and Azurite for stored files. */
export function resolveTownwiseConfig(
  config: TownwiseConfig & Pick<ServerConfig, 'NODE_ENV'>,
): ResolvedTownwiseConfig {
  if (config.NODE_ENV === 'production' && config.TOWNWISE_SUPERADMIN_EMAILS.length === 0) {
    throw new ConfigError('TOWNWISE_SUPERADMIN_EMAILS', 'production requires at least one staff address');
  }
  filesBackendOf(config);
  return {
    superadminEmails: new Set(config.TOWNWISE_SUPERADMIN_EMAILS),
    chatMonthlyBudgetUsd: config.TOWNWISE_CHAT_MONTHLY_BUDGET_USD,
  };
}
