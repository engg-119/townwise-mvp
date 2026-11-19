// correct_calendar_event (D66, openspec change town-research-agent design decision 12): TownwiseAI edits, hides or
// restores an event town research found, for this location only, when a person asks. It is the one tool that changes
// something at once besides start_calibration, and it has Undo: the change is a revision (spec 6.41) appended through the
// one writer (agent/apply.ts, `event.correct`, keyed by the conversation and the call) on the event's head as read now,
// so TownwiseAI's activity lists it and Undo appends a revert. Code checks it first: a researched event (`t-`/`l-` id)
// of this location or its town, never a curated row or holiday (`not_researched`); `title` and `where` through
// verify's safeText (`bad_title`) and the dates through its date rules (`bad_dates`); never staff (open as admin acts
// as `superadmin`) nor view-as; at most 5 a turn; none past the location's 1,000 revisions (`too_many_edits`). In a
// turn that read the web or a file (turn.readUntrusted, which every turn of a conversation that ever searched sets)
// nothing is written: the result proposes the change (`needs_tap`) and
// the card's Apply sends the person's own edit. It is not gated on TownwiseAI working on its own (a person asked, and
// it has Undo), and reading the calendar (turn.readNotTyped) does not block it. A turn that read researched events
// (turn.readResearchedDays, whose titles came from web pages) applies at most one correction itself and proposes the
// rest for a tap, so a planted title asking to hide other events changes one at most, with Undo. [CONFIRM: TownwiseAI
// corrects a researched event when a person asks, whether or not it works on its own; in a turn that read the web or a
// file it proposes the change for one tap instead; at most 5 a turn, at most 1 applied itself after reading researched
// events]
//
// The view keeps the call as the existing `tool` part (no new part type, no stream event): its result view is
// `{ applied, code, eventId, changeId, proposed }`, from which the client draws the card. Logs carry ids and the
// outcome only, never a title, a place or the why.
import { z } from 'zod';

import { applyChange, eventCorrectionCandidate } from '../../agent/apply.ts';
import { isoDate } from '../../dates.ts';
import { parseResearchedId, readResearchedViews, type ResearchedEventView } from '../../research/read.ts';
import { changedDates, MAX_LOCATION_REVISIONS } from '../../research/revisions.ts';
import { researchWindow } from '../../research/threads.ts';
import { datesRefused, MAX_TITLE_CHARS, safeText, TIME } from '../../research/verify.ts';
import type { RevisionFields } from '../../stores/research-revisions.ts';
import type { ChatTool, JsonValue, ToolContext } from './registry.ts';
import { DATE, viewOf } from './shared.ts';

/**
 * The ledger's cap on a why (stores/agent-changes.ts MAX_WHY_CHARS), written out here: only stores/index.ts and the
 * writer import the ledger (test/isolation.test.ts).
 */
const MAX_WHY_CHARS = 200;

/** At most this many calls a turn; the sixth and later answer `too_many`. */
export const MAX_CORRECTIONS_PER_TURN = 5;
/** How many of them apply themselves in a turn that read researched events; the rest answer needs_tap. */
export const MAX_DIRECT_AFTER_FOUND = 1;

/** The longest `where`, as the edit route's (handlers/research.ts). */
const MAX_WHERE_CHARS = MAX_TITLE_CHARS;

/** What the model may send for a text before safeText judges it: a longer one answers `bad_title`, not invalid input. */
const LOOSE_TEXT_CHARS = 1_000;

const CHANGES = ['edit', 'hide', 'restore'] as const;
type Change = typeof CHANGES[number];

const input = z.strictObject({
  eventId: z.string().max(64),
  change: z.enum(CHANGES),
  title: z.string().max(LOOSE_TEXT_CHARS).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().optional(),
  startTime: z.string().regex(TIME).nullable().optional(),
  where: z.string().max(LOOSE_TEXT_CHARS).nullable().optional(),
  why: z.string().max(MAX_WHY_CHARS),
});

type EditInput = Pick<z.infer<typeof input>, 'title' | 'start' | 'end' | 'weekdays' | 'startTime' | 'where'>;

export interface CorrectionInput {
  readonly eventId: string;
  readonly change: Change;
  /** An edit's values as the model sent them (at least one); null for a hide or a restore. */
  readonly edit: EditInput | null;
  readonly why: string | null;
}

/** The result's codes when nothing was applied. */
export type CorrectionCode =
  | 'needs_tap' | 'not_researched' | 'not_found' | 'bad_title' | 'bad_dates' | 'staff' | 'view_as' | 'too_many'
  | 'too_many_edits' | 'changed_since' | 'invalid' | 'duplicate';

const WORDS: Readonly<Record<Exclude<CorrectionCode, 'needs_tap'>, string>> = {
  not_researched: 'That is not an event town research found (a curated town row or a holiday), so it can’t be changed here.',
  not_found: 'This location has no researched event with that id (another town’s, or research is off). Read the calendar again for its id.',
  bad_title: 'That title or place can’t be used: plain words only, at most 120 characters, with no link, email address or phone number.',
  bad_dates: 'Those dates can’t be used: the start on or before the end, within the next 180 days, and any weekdays inside them.',
  staff: 'Townwise staff can’t change an organization’s calendar through TownwiseAI. Ask a member of the organization.',
  view_as: 'Nothing can be changed while viewing as someone else.',
  too_many: `At most ${String(MAX_CORRECTIONS_PER_TURN)} calendar corrections run in one reply. Ask the owner to ask for the rest in a new message.`,
  too_many_edits: 'This location has 1,000 edits of researched events, the most it can hold, so nothing changed.',
  changed_since: 'Someone changed this event just now. Read the calendar again and ask the owner before trying again.',
  invalid: 'The correction couldn’t be saved. Nothing changed.',
  duplicate: 'This correction was already made.',
};

const NEEDS_TAP = 'This conversation read a web page or a file, so nothing was changed: the owner sees the change as a card and applies it with one tap if it’s right.';
/** D66: the corrections past the first in a reply that read researched events (their titles came from web pages). */
const NEEDS_TAP_FOUND = 'This reply read events research found on the web, and only one correction applies on its own after that, so nothing was changed: the owner sees the change as a card and applies it with one tap if it’s right.';
const APPLIED = 'Changed on this location’s calendar only. The owner can undo it from TownwiseAI’s activity.';

function json(value: Readonly<Record<string, JsonValue>>): { content: string } {
  return { content: JSON.stringify(value) };
}

function refused(eventId: string, code: Exclude<CorrectionCode, 'needs_tap'>): { content: string } {
  return json({ applied: false, code, eventId, changeId: null, proposed: null, message: WORDS[code] });
}

/**
 * An edit's values checked as the edit route checks a person's (handlers/research.ts): `title` and `where` by safeText,
 * and the dates as they would then show by verify's rules (a start the edit keeps is held to no window, so an ongoing
 * season stays editable). Weekdays are deduplicated and sorted. Answers the fields, or the code refusing them.
 */
export function checkEdit(view: ResearchedEventView, edit: EditInput, window: { from: string; to: string }): RevisionFields | 'bad_title' | 'bad_dates' {
  const title = edit.title === undefined ? undefined : safeText(edit.title, MAX_TITLE_CHARS);
  const where = edit.where === undefined || edit.where === null ? edit.where : safeText(edit.where, MAX_WHERE_CHARS);
  if (title === null || (where === null && edit.where !== null && edit.where !== undefined)) return 'bad_title';
  // Only the dates that differ from the shown event count as typed (the edit sheet sends all three every time).
  const dates = changedDates(view, edit);
  const { weekdays } = dates;
  const datesChanged = dates.start !== undefined || dates.end !== undefined || weekdays !== undefined;
  const startWindow = dates.start !== undefined ? window : {
    from: view.start < window.from ? view.start : window.from, to: view.start > window.to ? view.start : window.to,
  };
  if (datesChanged && datesRefused({
    kind: view.kind, startDate: dates.start ?? view.start, endDate: dates.end ?? view.end,
    weekdays: weekdays === undefined ? (view.weekdays === null ? null : [...view.weekdays]) : weekdays,
  }, startWindow)) return 'bad_dates';
  return {
    ...(title !== undefined ? { title } : {}),
    ...(dates.start !== undefined ? { start: dates.start } : {}),
    ...(dates.end !== undefined ? { end: dates.end } : {}),
    ...(weekdays !== undefined ? { weekdays } : {}),
    ...(edit.startTime !== undefined ? { startTime: edit.startTime } : {}),
    ...(where !== undefined ? { where } : {}),
  };
}

function fieldsJson(fields: RevisionFields | null): JsonValue {
  if (fields === null) return null;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Array.isArray(value) ? [...value as number[]] : value as JsonValue]));
}

async function correct(tc: ToolContext, request: CorrectionInput, callId: string | undefined): Promise<{ content: string }> {
  const { ctx, scope, location, actor } = tc;
  const { eventId } = request;
  // Staff open as admin act as 'superadmin' (handlers/team.ts actorOf); view-as sends no turn, and is refused here too.
  if (actor.actorRole === 'superadmin') return refused(eventId, 'staff');
  if (actor.viewAsGrantId !== null) return refused(eventId, 'view_as');
  const made = tc.turn.corrections ?? 0;
  tc.turn.corrections = made + 1;
  if (made >= MAX_CORRECTIONS_PER_TURN) return refused(eventId, 'too_many');
  // A curated row's or a holiday's id is no researched event: they feed the forecast and are not editable.
  if (parseResearchedId(eventId) === null) return refused(eventId, 'not_researched');
  // Hidden events included (a restore), read under the caller's own scope and location: another town's row, another
  // location's or organization's, or any while research is off for the organization, is not found.
  const view = (await readResearchedViews(ctx, scope, location, null)).find((each) => each.id === eventId) ?? null;
  if (view === null) return refused(eventId, 'not_found');
  const fields = request.edit === null ? null : checkEdit(view, request.edit, researchWindow(ctx.now(), tc.timeZone));
  if (fields === 'bad_title' || fields === 'bad_dates') return refused(eventId, fields);
  // Decision 11's cap, as the edit route checks it (agent/changes.ts targetStates reads every revision of the location
  // on that bound). Checked before needs_tap too: the card's Apply would only meet the route's 409.
  if (await ctx.stores.researchRevisions.count(scope, location.id) >= MAX_LOCATION_REVISIONS) return refused(eventId, 'too_many_edits');
  const direct = tc.turn.directCorrections ?? 0;
  const capped = (tc.turn.readResearchedDays?.size ?? 0) > 0 && direct >= MAX_DIRECT_AFTER_FOUND;
  if (tc.turn.readUntrusted || capped || callId === undefined) {
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, conversationId: tc.conversationId, eventId, outcome: 'needs_tap' }, 'townwise.chat_event_corrected');
    return json({
      applied: false, code: 'needs_tap', eventId, changeId: null, proposed: { change: request.change, fields: fieldsJson(fields) }, message: tc.turn.readUntrusted || !capped ? NEEDS_TAP : NEEDS_TAP_FOUND,
    });
  }
  tc.turn.directCorrections = direct + 1;
  const { outcome, change } = await applyChange(ctx, scope, eventCorrectionCandidate(ctx, scope, {
    locationId: location.id, conversationId: tc.conversationId, callId, eventId, op: request.change, fields, basedOn: view.head,
    why: request.why, onBehalfOf: actor.actorUserId, actor,
  }));
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, conversationId: tc.conversationId, eventId, outcome }, 'townwise.chat_event_corrected');
  if (outcome === 'applied' && change !== null) {
    return json({ applied: true, code: null, eventId, changeId: change.id, proposed: null, message: APPLIED });
  }
  return refused(eventId, outcome === 'conflict' ? 'changed_since' : outcome === 'duplicate' ? 'duplicate' : 'invalid');
}

const proposedSchema = z.object({ change: z.enum(CHANGES), fields: z.record(z.string(), z.unknown()).nullable() });
const resultSchema = z.object({
  applied: z.boolean(), code: z.string().nullable(), eventId: z.string(), changeId: z.string().nullable(), proposed: proposedSchema.nullable(),
});

export const correctCalendarEventTool: ChatTool<CorrectionInput> = {
  definition: {
    name: 'correct_calendar_event',
    description: 'Corrects an event town research found, on this location’s calendar only, when the person asks you to: edit its title, dates, weekdays, start time or place, hide it, or restore it. Only an event in `found` from get_town_calendar or get_day (an id starting t- or l-); the curated town calendar and holidays can’t be changed. For edit, send only the fields that change. why says in a few words what the person told you. Townwise saves it with Undo; in a conversation that read a web page or a file it only shows the owner the change to apply with one tap, and the result says which happened. At most five a reply.',
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'The event’s id from found, t- or l- and 24 hex characters' },
        change: { type: 'string', enum: [...CHANGES] },
        title: { type: 'string', maxLength: MAX_TITLE_CHARS },
        start: DATE,
        end: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        weekdays: { type: ['array', 'null'], items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'null for every day of its dates, or the days it is held on, 0 (Sunday) to 6' },
        startTime: { type: ['string', 'null'], description: 'HH:MM, 24-hour' },
        where: { type: ['string', 'null'], maxLength: MAX_WHERE_CHARS },
        why: { type: 'string', maxLength: MAX_WHY_CHARS },
      },
      required: ['eventId', 'change', 'why'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Not a valid correction, so nothing changed. Edit needs at least one field to change; hide and restore take none. Check the input schema and try again.',
  parse(raw) {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return null;
    const { eventId, change, why, ...rest } = parsed.data;
    const hasFields = Object.values(rest).some((value) => value !== undefined);
    if (change === 'edit' ? !hasFields : hasFields) return null;
    const trimmed = why.trim();
    return { eventId, change, edit: change === 'edit' ? rest : null, why: trimmed === '' ? null : trimmed };
  },
  inputView: ({ eventId, change }) => ({ eventId, change }),
  resultView: (content) => viewOf(content, resultSchema, ({ applied, code, eventId, changeId, proposed }) => ({
    applied, code, eventId, changeId,
    proposed: proposed === null ? null : { change: proposed.change, fields: proposed.fields as Readonly<Record<string, JsonValue>> | null },
  })),
  run: (tc, request, callId) => correct(tc, request, callId),
};
