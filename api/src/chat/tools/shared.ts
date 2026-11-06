// Pieces the tools share.
import { z } from 'zod';

import type { ToolView } from './registry.ts';

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

/** A tool result read back through `schema`, then mapped to its view; null when it does not parse. */
export function viewOf<T>(content: string, schema: z.ZodType<T>, view: (value: T) => ToolView): ToolView | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? view(parsed.data) : null;
}
