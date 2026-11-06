// Pieces the tools share.
import { z } from 'zod';

export const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const;

export const DATE = { type: 'string', description: 'YYYY-MM-DD' } as const;

export const INVALID_INPUT = 'Invalid input for this tool. Check the input schema and try again.';

const noInput = z.object({});

/** The input of a tool that takes none: `{}` (unknown keys are ignored, as zod's default object does). */
export function parseNoInput(raw: unknown): Record<string, never> | null {
  return noInput.safeParse(raw).success ? {} : null;
}

export function dollars(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}
