// Pieces the tools share.
import { z } from 'zod';

import { TOWNWISE_AI_AUTHOR } from '../../agent/apply.ts';
import { eachDay } from '../../forecasts/file.ts';
import { researchedEventsFor, type DayRange } from '../../research/read.ts';
import type { NoteRecord } from '../../stores/notes.ts';
import { weekdayOf } from '../../time-zones.ts';
import type { ToolContext, ToolView } from './registry.ts';

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

/** The days of `from` to `to` (inclusive) that fall on `weekdays` (0 Sunday to 6), every one when null. */
export function daysOn(from: string, to: string, weekdays: readonly number[] | null): string[] {
  return eachDay(from, to).filter((day) => weekdays === null || weekdays.includes(new Date(`${day}T00:00:00.000Z`).getUTCDay()));
}

/**
 * D66 (design decision 12): the researched events of the location falling on a day of `range` (by their dates and
 * weekdays), after this location's edits, hidden ones left out, as get_town_calendar and get_day hand them to the model
 * (`found`: `[]` while research is off, null when the read fails). Each carries its id and head, the eventId and basedOn
 * a correction names. The days of `range` they fall on are added to the turn's `readResearchedDays`, so propose_note
 * saves no note on one of them itself: those events came from web pages nobody typed into Townwise.
 */
export async function researchedForModel(tc: ToolContext, range: DayRange): Promise<Record<string, unknown>[] | null> {
  const read = await researchedEventsFor(tc.ctx, tc.scope, tc.location, range);
  if (read === null) return null;
  const views = read.flatMap((view) => {
    const from = view.start < range.from ? range.from : view.start;
    const to = view.end > range.to ? range.to : view.end;
    const days = from <= to ? daysOn(from, to, view.weekdays) : [];
    return days.length === 0 ? [] : [{ view, days }];
  });
  if (views.length > 0) {
    const seen = tc.turn.readResearchedDays ?? new Set<string>();
    for (const { days } of views) for (const day of days) seen.add(day);
    tc.turn.readResearchedDays = seen;
  }
  return views.map(({ view }) => ({
    id: view.id, head: view.head, title: view.title, start: view.start, startWeekday: weekdayOf(view.start), end: view.end,
    endWeekday: weekdayOf(view.end), weekdays: view.weekdays, startTime: view.startTime, kind: view.kind, category: view.category,
    status: view.status, origin: view.origin, confidence: view.confidence, where: view.where, who: view.who, sources: view.sources,
    edited: view.edited, lastConfirmed: view.lastSeenAt.slice(0, 10),
  }));
}
