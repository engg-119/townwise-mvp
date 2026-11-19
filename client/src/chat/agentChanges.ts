import { z } from 'zod';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/client';
import { withOrgId } from '../portal/api';
import { noteSchema, type Note } from '../portal/locations/api';
import { KIND_LABEL, rangeText } from './format';

// D59 (openspec change auto-apply-agent-reads): TownwiseAI working on its own, as the client reads it: the
// organization's switch (GET .../agent's `agentAuto`, PATCH /api/org/agent-auto), each change TownwiseAI saved (the
// activity's `agent_change`, the log at GET .../agent/changes) and Undo of one (POST .../agent/changes/:id/undo), and
// the events a file read wasn't sure of (`noteSuggestions`, decided through the suggested rules' routes). Changes carry
// ids, dates and kinds only; every word here is the client's. [CONFIRM: the panel's and switch's words]

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NOTE_KIND = z.enum(['closure', 'private_event', 'opening', 'other']);
export const CHANGE_ACTIONS = ['note.add', 'item.add', 'sales_days.add', 'rule.add', 'booking.label'] as const;
const actionSchema = z.enum(CHANGE_ACTIONS);
const statusSchema = z.enum(['applying', 'applied', 'undoing', 'undone', 'adopted']);
const sourceKindSchema = z.enum(['file', 'calendar', 'weekly', 'chat']);

/** The activity's item for one change: no title, why, file name or figure. */
export const agentChangeItemSchema = z.object({
  at: z.string(), kind: z.literal('agent_change'), changeId: z.string(), action: actionSchema, sourceKind: sourceKindSchema,
  status: statusSchema, startDate: dateSchema.nullable(), endDate: dateSchema.nullable(), noteKind: NOTE_KIND.nullable(), undoable: z.boolean(),
});
export type AgentChangeItem = z.infer<typeof agentChangeItemSchema>;

/** The switch: on unless an org admin turned it off; `available` while it can run here; `canChange` for an org admin outside view-as. */
export const agentAutoSchema = z.object({ on: z.boolean(), available: z.boolean(), canChange: z.boolean() });
export type AgentAuto = z.infer<typeof agentAutoSchema>;

/** An event a file read wasn't sure of, waiting for a member: the note accepting writes, and its file (null once deleted). */
export const noteSuggestionSchema = z.object({
  id: z.string(), source: z.literal('file'),
  note: z.object({
    kind: NOTE_KIND, startDate: dateSchema, endDate: dateSchema, weekdays: z.array(z.number().int()).nullable(),
    effect: z.enum(['closed', 'more_guests', 'fewer_guests', 'unknown']), expectedGuests: z.number().int().nullable(),
    startTime: z.string().nullable(), endTime: z.string().nullable(), detail: z.string().nullable(), title: z.string().nullable(),
  }),
  file: z.object({ ref: z.string(), title: z.string().nullable() }).nullable(),
  canDecide: z.boolean(),
});
export type NoteSuggestion = z.infer<typeof noteSuggestionSchema>;

/** A change as the log lists it: the why is null under view-as. */
export const agentChangeSchema = z.object({
  id: z.string(), at: z.string(), action: actionSchema, sourceKind: sourceKindSchema, sourceRef: z.string().nullable(), status: statusSchema,
  startDate: dateSchema.nullable(), endDate: dateSchema.nullable(), noteKind: NOTE_KIND.nullable(), why: z.string().nullable(),
  undoable: z.boolean(), targetId: z.string().nullable(),
});
export type AgentChange = z.infer<typeof agentChangeSchema>;

const logSchema = z.object({ changes: z.array(z.unknown()), next: z.string().nullable() });
const undoneSchema = z.object({ change: agentChangeSchema });
const switchedSchema = z.object({ agentAuto: z.object({ on: z.boolean() }) });
const noteDecidedSchema = z.object({
  suggestion: z.object({ id: z.string(), status: z.enum(['accepted', 'dismissed']) }), note: noteSchema.nullable(),
});

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

/** PATCH /api/org/agent-auto { on, orgId? } (orgId from openAsAdminOrgId). Staff open as admin may only turn it off. */
export async function setAgentAuto(api: ApiClient, on: boolean, orgId: string | null): Promise<boolean> {
  const body = await api.json('/api/org/agent-auto', switchedSchema, { method: 'PATCH', body: withOrgId({ on }, orgId) });
  return body.agentAuto.on;
}

/** POST .../agent/changes/:changeId/undo: the change as it is after (undone). */
export async function undoChange(api: ApiClient, locationId: string, changeId: string): Promise<AgentChange> {
  const body = await api.json(`${locationPath(locationId)}/agent/changes/${encodeURIComponent(changeId)}/undo`, undoneSchema, { method: 'POST' });
  return body.change;
}

/** GET .../agent/changes?before=: 50 changes, newest first; `next` reads the page after. A change this client can't read is left out. */
export async function loadChanges(api: ApiClient, locationId: string, before: string | null = null): Promise<{ changes: AgentChange[]; next: string | null }> {
  const query = before === null ? '' : `?before=${encodeURIComponent(before)}`;
  const body = await api.json(`${locationPath(locationId)}/agent/changes${query}`, logSchema);
  return {
    changes: body.changes.flatMap((item) => {
      const parsed = agentChangeSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    next: body.next,
  };
}

/** Confirm or dismiss an event a file read wasn't sure of: Confirm writes it as the caller's note. */
export async function decideNoteSuggestion(
  api: ApiClient, locationId: string, suggestionId: string, decision: 'accept' | 'dismiss',
): Promise<{ status: 'accepted' | 'dismissed'; note: Note | null }> {
  const body = await api.json(
    `${locationPath(locationId)}/agent/rule-suggestions/${encodeURIComponent(suggestionId)}/${decision}`, noteDecidedSchema, { method: 'POST', body: {} },
  );
  return { status: body.suggestion.status, note: body.note };
}

/** The page a change's target lives on, for the 409's words. */
function pageOf(action: AgentChange['action']): string {
  return action === 'note.add' ? 'Notes' : action === 'rule.add' ? 'Business rules' : action === 'booking.label' ? 'Your calendars' : 'Your data';
}

/** What a change added, in a few words: "a note: Private event, Jun 13, 2026". */
function whatOf(change: Pick<AgentChange, 'action' | 'noteKind' | 'startDate' | 'endDate'>): string {
  const dates = change.startDate === null || change.endDate === null ? '' : rangeText(change.startDate, change.endDate);
  switch (change.action) {
    case 'note.add': return `a note: ${change.noteKind === null ? 'Note' : KIND_LABEL[change.noteKind]}${dates === '' ? '' : `, ${dates}`}`;
    case 'sales_days.add': return `sales days you didn’t have${dates === '' ? '' : ` for ${dates}`}`;
    case 'item.add': return 'a summary of a file';
    case 'rule.add': return 'a business rule';
    case 'booking.label': return 'a booking label';
  }
}

const SOURCE_WORDS: Readonly<Record<AgentChange['sourceKind'], string>> = {
  file: 'from a file you added', calendar: 'from your calendar', weekly: 'from its weekly look ahead', chat: 'from your message',
};

/** The activity's and the log's line for a change. */
export function changeLine(change: Pick<AgentChange, 'action' | 'noteKind' | 'startDate' | 'endDate' | 'sourceKind' | 'status'>): string {
  const added = `Added ${whatOf(change)}, ${SOURCE_WORDS[change.sourceKind]}.`;
  if (change.status === 'undone') return `${added} Undone.`;
  if (change.status === 'adopted') return `${added} You changed it since, so it’s yours.`;
  return added;
}

/** "{n} things TownwiseAI wasn't sure of are waiting for you", or null with none. */
export function waitingLine(waiting: number): string | null {
  if (waiting <= 0) return null;
  return waiting === 1 ? '1 thing TownwiseAI wasn’t sure of is waiting for you.' : `${String(waiting)} things TownwiseAI wasn’t sure of are waiting for you.`;
}

/** An Undo that failed, in words; 409 changed_since names the page the target lives on. */
export function undoErrorText(error: unknown, action: AgentChange['action']): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'changed_since') return `You changed this since, so it’s yours now. Delete it from ${pageOf(action)} if you don’t want it.`;
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t undo this.';
    if (error.code === 'forbidden') return action === 'sales_days.add' ? 'Only an org admin can undo added sales days.' : 'You can’t undo this.';
    if (error.status === 404) return 'This change is gone.';
  }
  return 'Couldn’t undo this. Try again.';
}

/** The switch's words (design decision 14). [CONFIRM: the panel's and switch's words] */
export const AGENT_AUTO_WORDS = 'Let TownwiseAI work on its own. It reads each file you add to Your data and saves what it’s sure of, such as a dated private event, so the forecast updates. Each change shows here with Undo. Anything it isn’t sure of waits for you.';

/** How TownwiseAI works' sentence, by the switch (design decision 14). [CONFIRM: the panel's and switch's words] */
export function savesLine(on: boolean): string {
  return on
    ? 'It saves what it’s sure of and shows each change here with Undo. Anything it isn’t sure of waits for you.'
    : 'It suggests notes; it saves one only when you ask, or when you let it read a file.';
}
