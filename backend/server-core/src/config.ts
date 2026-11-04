import { z } from 'zod';

interface ConfigProblem {
  readonly variable: string;
  readonly problem: string;
}

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().min(1),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(4000000).default(65000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(6000).max(115000).default(25000),
});

export type ServerConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(variable: string, problem: string);
  constructor(problems: readonly ConfigProblem[]);
  constructor(variableOrProblems: string | readonly ConfigProblem[], problem?: string) {
    const problems = typeof variableOrProblems === 'string'
      ? [{ variable: variableOrProblems, problem: problem ?? '' }]
      : variableOrProblems.map((entry) => ({ variable: entry.variable, problem: entry.problem }));
    super(problems.map((entry) => `${entry.variable}: ${entry.problem}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Parses `source` against `schema`. Empty strings count as unset. Throws ConfigError naming
 *  variables and zod messages only, never values. */
export function loadEnv<S extends z.ZodObject>(
  schema: S,
  source: Readonly<Record<string, string | undefined>>,
): z.infer<S> {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = source[key];
    input[key] = value === '' ? undefined : value;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => ({
      variable: String(issue.path[0]),
      problem: issue.message,
    })));
  }
  return parsed.data;
}
