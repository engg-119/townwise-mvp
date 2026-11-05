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
});

export type TownwiseConfig = z.infer<typeof configSchema>;

export interface ResolvedTownwiseConfig {
  readonly superadminEmails: ReadonlySet<string>;
  readonly chatMonthlyBudgetUsd: number;
}

/** Production refuses an empty staff list (spec Section 18). */
export function resolveTownwiseConfig(
  config: TownwiseConfig & Pick<ServerConfig, 'NODE_ENV'>,
): ResolvedTownwiseConfig {
  if (config.NODE_ENV === 'production' && config.TOWNWISE_SUPERADMIN_EMAILS.length === 0) {
    throw new ConfigError('TOWNWISE_SUPERADMIN_EMAILS', 'production requires at least one staff address');
  }
  return {
    superadminEmails: new Set(config.TOWNWISE_SUPERADMIN_EMAILS),
    chatMonthlyBudgetUsd: config.TOWNWISE_CHAT_MONTHLY_BUDGET_USD,
  };
}
