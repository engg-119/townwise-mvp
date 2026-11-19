import { z } from 'zod';

import type { ApiClient } from '../api/client';
import { fetchCalendar, type ResearchedEvent } from '../portal/analytics/api';
import { addDays } from '../portal/locations/dates';
import { fetchResearch, updateResearchedEvent } from '../portal/research/api';
import type { CorrectionChange, CorrectionFields } from '../portal/research/copy';
import type { ToolView } from './api';

// D66 (openspec change town-research-agent, design decision 12): the correction card TownwiseAI's correct_calendar_event
// call draws, read from its existing `tool` part (no new part type): `{ applied, code, eventId, changeId, proposed }`.
// A correction it made carries the change's id, for Undo through the change's own route (agentChanges.ts undoChange);
// one it proposed in a turn that read a web page or a file (`needs_tap`) carries the change, and Apply sends the
// person's own PATCH .../research/events/:eventId (research/api.ts) on the head of a fresh read: the tap is the person's
// confirmation, recorded as their revision, which Reset on the Calendar undoes. A call that changed nothing stays a
// tool row (tools.ts).

/** The tool whose calls draw the correction card. */
export const CORRECTION_TOOL = 'correct_calendar_event';

/** A correction card: the call's id, the event's, and what was done (`changeId`) or proposed (`proposed`). */
export type CorrectionCard =
  | { id: string; eventId: string; kind: 'applied'; change: CorrectionChange; changeId: string }
  | { id: string; eventId: string; kind: 'proposed'; change: CorrectionChange; fields: CorrectionFields | null };

const CHANGE = z.enum(['edit', 'hide', 'restore']);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const fieldsSchema = z.object({
  title: z.string().optional(),
  start: DATE.optional(),
  end: DATE.optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  startTime: TIME.nullable().optional(),
  where: z.string().nullable().optional(),
}).strip();
const appliedSchema = z.object({ applied: z.literal(true), eventId: z.string(), changeId: z.string().min(1) });
const proposedSchema = z.object({
  applied: z.literal(false), code: z.literal('needs_tap'), eventId: z.string(),
  proposed: z.object({ change: CHANGE, fields: fieldsSchema.nullable() }),
});

/** Only the fields present, so an absent one never reads as a change to null. */
function present(fields: z.infer<typeof fieldsSchema>): CorrectionFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * The card a finished correct_calendar_event call draws, or null when it stays a row (it is still running, failed, or
 * changed nothing). A made correction's change is its input view's (`{ eventId, change }`).
 */
export function correctionOf(step: { id: string; name: string; state: string; input: ToolView | null; result: ToolView | null }): CorrectionCard | null {
  if (step.name !== CORRECTION_TOOL || step.state !== 'done' || step.result === null) return null;
  const applied = appliedSchema.safeParse(step.result);
  if (applied.success) {
    const change = CHANGE.safeParse(step.input?.change);
    return change.success
      ? { id: step.id, eventId: applied.data.eventId, kind: 'applied', change: change.data, changeId: applied.data.changeId }
      : null;
  }
  const proposed = proposedSchema.safeParse(step.result);
  if (!proposed.success) return null;
  const { change, fields } = proposed.data.proposed;
  return { id: step.id, eventId: proposed.data.eventId, kind: 'proposed', change, fields: fields === null ? null : present(fields) };
}

/** The event as this location sees it now: its view on the calendar, or a hidden one's head from the Town tab's read. */
interface Fresh { head: string; shown: ResearchedEvent | null }

/**
 * A fresh read of the event's head: the calendar over the last year and the next 395 days (the API's limit is 400
 * past its UTC day), and, when the event isn't shown there, the hidden events of GET .../research. Null when this
 * location can no longer see it. A calendar read whose found events failed throws, as any failed read does.
 */
async function freshHead(api: ApiClient, locationId: string, eventId: string, today: string): Promise<Fresh | null> {
  const calendar = await fetchCalendar(api, locationId, { from: addDays(today, -365), to: addDays(today, 395) });
  if (calendar.found === null) throw new Error('found_unavailable');
  const shown = calendar.found.find((event) => event.id === eventId);
  if (shown !== undefined) return { head: shown.head, shown };
  const hidden = (await fetchResearch(api, locationId)).hidden.find((event) => event.id === eventId);
  return hidden === undefined ? null : { head: hidden.head, shown: null };
}

/** Whether the event already reads as the proposal would leave it: a second tap, or a person made the same change. */
function alreadyApplied(card: Extract<CorrectionCard, { kind: 'proposed' }>, fresh: Fresh): boolean {
  if (card.change === 'hide') return fresh.shown === null;
  if (card.change === 'restore') return fresh.shown !== null && !fresh.shown.edited;
  const { shown } = fresh;
  if (shown === null || card.fields === null) return false;
  return Object.entries(card.fields).every(([key, value]) => {
    const now: unknown = shown[key as keyof CorrectionFields];
    return Array.isArray(value) && Array.isArray(now) ? value.join() === now.join() : value === now;
  });
}

/**
 * Apply on a proposed correction: `applied` once the person's own edit, hide or restore is saved; `already` when the
 * event already reads that way (nothing is sent); `changed_since` when someone changed it between the read and the
 * write; `gone` when this location can no longer see it. Any other refusal throws its ApiError.
 */
export async function applyCorrection(
  api: ApiClient, locationId: string, card: Extract<CorrectionCard, { kind: 'proposed' }>, today: string,
): Promise<'applied' | 'already' | 'changed_since' | 'gone'> {
  const fresh = await freshHead(api, locationId, card.eventId, today);
  if (fresh === null) return 'gone';
  if (alreadyApplied(card, fresh)) return 'already';
  const result = card.change === 'edit'
    ? await updateResearchedEvent(api, locationId, card.eventId, { op: 'edit', fields: card.fields ?? {}, basedOn: fresh.head })
    : await updateResearchedEvent(api, locationId, card.eventId, { op: card.change, basedOn: fresh.head });
  return result.status === 'saved' ? 'applied' : 'changed_since';
}
