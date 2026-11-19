// Pieces the tools share.
import { z } from 'zod';

import { TOWNWISE_AI_AUTHOR } from '../../agent/apply.ts';
import type { NoteRecord } from '../../stores/notes.ts';
import type { ToolView } from './registry.ts';

/**
 * D59 slice 4: whether a note's words may be ones nobody typed into Townwise: TownwiseAI wrote it from a file or a
 * calendar (its author, or a file `source`), or it was made from a calendar event (`fromEvent`). Edited or not, its
 * title and detail may still be the source's words. A tool that lists one sets ToolContext.turn.readNotTyped.
 */
export function notTypedNote(note: Pick<NoteRecord, 'createdBy' | 'source' | 'fromEvent'>): boolean {
  return note.createdBy === TOWNWISE_AI_AUTHOR || note.source !== null || note.fromEvent !== null;
}

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

/** U13A: at most this many source links on a card. */
const MAX_SOURCE_LINKS = 5;

/** U13A: the distinct https links among `urls`, in order, at most 5, each with its host (no www.) for display. */
export function sourceLinks(urls: readonly string[]): { host: string; url: string }[] {
  return [...new Set(urls)].flatMap((url) => {
    const parsed = URL.parse(url);
    return parsed?.protocol === 'https:' ? [{ host: parsed.hostname.replace(/^www\./, ''), url }] : [];
  }).slice(0, MAX_SOURCE_LINKS);
}
