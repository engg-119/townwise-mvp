import { z } from 'zod';

import { ApiError, type ApiClient } from '../../api/client';
import { researchedEventSchema, type ResearchedEvent } from '../analytics/api';
import { withOrgId } from '../api';
import { placeMapSchema } from '../places/map';

// The town research routes (D66, OpenSpec change town-research-agent, design decision 13; api/README.md): the
// location's research status, Research now, an edit, hide or restore of a researched event, the organization's research
// switch and the Competition card. The Calendar's `found` is read with the calendar (analytics/api.ts). Lists are read
// item by item, so one item this client can't read never fails the page; an unknown status or gap reads as nothing.

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

/** An array read item by item: an item `schema` refuses is left out, anything but an array reads `[]`. */
function eachOf<T>(schema: z.ZodType<T>): z.ZodType<T[]> {
  return z.unknown().optional().transform((value) => (Array.isArray(value) ? value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }) : []));
}

export const RUN_STATUSES = ['queued', 'running', 'merging', 'done', 'partial', 'failed', 'budget', 'off'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** A run that has not finished: the Town tab polls and the Calendar's banner says it is researching. */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'merging'];
/** Who started a location's run: the weekly plan, the early run after a location is created or its place picked, or Research now. */
export const RUN_TRIGGERS = ['weekly', 'early', 'press'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const RESEARCH_GAPS = ['no_place', 'not_researched_town', 'off', 'budget', 'places_off'] as const;
export type ResearchGap = (typeof RESEARCH_GAPS)[number];

const countsSchema = z.object({ found: z.number(), added: z.number(), updated: z.number(), dropped: z.number() });
const threadSchema = z.object({ thread: z.string(), status: z.string(), code: z.string().nullable() });

/** A town run: no trigger and no start, so nothing another organization did shows. */
export const townRunSchema = z.object({
  status: z.enum(RUN_STATUSES),
  finishedAt: z.string().nullable(),
  threads: eachOf(threadSchema),
  counts: countsSchema,
});
export type TownRun = z.infer<typeof townRunSchema>;

/** The location's own run, with what started it and when. */
export const locationRunSchema = townRunSchema.extend({ trigger: z.enum(RUN_TRIGGERS), startedAt: z.string().nullable() });
export type LocationRun = z.infer<typeof locationRunSchema>;

const entitySchema = z.object({ id: z.string(), type: z.string(), name: z.string(), events: z.number() });
const hiddenSchema = z.object({ id: z.string(), title: z.string(), start: z.string(), end: z.string(), head: z.string() });
export type HiddenEvent = z.infer<typeof hiddenSchema>;

/** GET .../research (`org.research.get`). A run this client can't read is shown as none. */
export const researchSchema = z.object({
  /** The organization's own switch. */
  on: z.boolean(),
  /** Whether this deploy runs research at all. */
  available: z.boolean(),
  town: townRunSchema.nullable().catch(null),
  location: locationRunSchema.nullable().catch(null),
  /** The next weekly run's day (YYYY-MM-DD, the town's zone), or null. */
  next: z.string().nullable(),
  gaps: z.array(z.string()).transform((gaps) => gaps.filter((gap): gap is ResearchGap => (RESEARCH_GAPS as readonly string[]).includes(gap))),
  entities: eachOf(entitySchema),
  hidden: eachOf(hiddenSchema),
});
export type Research = z.infer<typeof researchSchema>;

export function fetchResearch(api: ApiClient, locationId: string): Promise<Research> {
  return api.json(`${locationPath(locationId)}/research`, researchSchema);
}

/**
 * POST .../research/run (Research now; org admins, never staff open as admin): re-runs the location's topics. The page
 * reads GET .../research again for the run. Refusals are ApiErrors: 409 `research_running` or `too_soon`, 503
 * `research_off`, 429 from the `research` limiter (3 a day).
 */
export async function runResearch(api: ApiClient, locationId: string): Promise<void> {
  await api.json(`${locationPath(locationId)}/research/run`, z.unknown(), { method: 'POST', body: {} });
}

/** The fields an edit sends: the event's shown values, changed. `weekdays` are 0 (Sunday) to 6. */
export interface ResearchedEventFields {
  title: string;
  start: string;
  end: string;
  weekdays: number[] | null;
  startTime: string | null;
  where: string | null;
}

/**
 * What an edit, hide or restore (Reset) sends: the op, and the view's `head` it was made from. The Calendar's sheet sends
 * every field; a TownwiseAI correction's Apply (task 7.4) sends only those it proposed, which the API takes (at least one).
 */
export type ResearchedEventChange =
  | { op: 'edit'; fields: Partial<ResearchedEventFields>; basedOn: string }
  | { op: 'hide' | 'restore'; basedOn: string };

/**
 * An edit's answer: saved (with the event as it is now, when the API sent it), or 409 `changed_since`, someone changed
 * it since this view was read, with the event's current view when the API sent one (its new `head` is what a retry
 * sends), and whether that view is hidden (another member hid it meanwhile: the schema keeps no `hidden`, so it is read
 * apart). Every other failure throws.
 */
export type ResearchedEventResult =
  | { status: 'saved'; event: ResearchedEvent | null }
  | { status: 'changed_since'; current: ResearchedEvent | null; hidden: boolean };

function viewOf(value: unknown): ResearchedEvent | null {
  const parsed = researchedEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * PATCH .../research/events/:eventId { op, fields, basedOn } (`org.research.event_update`; any member and staff open as
 * admin, never view-as): appends a revision for this location only. The API answers the event in `event`, and a 409
 * `changed_since` body carries the current view in `event` too (design decision 11).
 */
export async function updateResearchedEvent(
  api: ApiClient, locationId: string, eventId: string, change: ResearchedEventChange,
): Promise<ResearchedEventResult> {
  const path: `/${string}` = `${locationPath(locationId)}/research/events/${encodeURIComponent(eventId)}`;
  try {
    const body = await api.json(path, z.object({ event: z.unknown().optional() }), { method: 'PATCH', body: change });
    return { status: 'saved', event: viewOf(body.event) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === 'changed_since') {
      const hidden = z.object({ hidden: z.boolean() }).safeParse(error.detail?.event);
      return { status: 'changed_since', current: viewOf(error.detail?.event), hidden: hidden.success && hidden.data.hidden };
    }
    throw error;
  }
}

const switchedSchema = z.object({ research: z.object({ on: z.boolean() }) });

/** PATCH /api/org/research { on, orgId? } (orgId from openAsAdminOrgId): the organization's switch; staff open as admin may only turn it off. */
export async function setResearch(api: ApiClient, on: boolean, orgId: string | null): Promise<boolean> {
  const body = await api.json('/api/org/research', switchedSchema, { method: 'PATCH', body: withOrgId({ on }, orgId) });
  return body.research.on;
}

const competitorSchema = z.object({
  letter: z.string(),
  placeId: z.string(),
  name: z.string(),
  type: z.string(),
  distanceM: z.number(),
  /** The pin's place on the map as fractions of its width and height; null without a map. */
  x: z.number().nullable(),
  y: z.number().nullable(),
  events: eachOf(researchedEventSchema),
});
export type Competitor = z.infer<typeof competitorSchema>;

/** GET .../competition?theme= (`org.competition.get`): the lettered map, each competitor's events, and the web list. */
export const competitionSchema = z.object({
  gap: z.enum(['no_place', 'places_off']).nullable().catch(null),
  map: placeMapSchema.catch(null),
  competitors: eachOf(competitorSchema),
  web: eachOf(z.object({ name: z.string(), events: eachOf(researchedEventSchema) })),
});
export type Competition = z.infer<typeof competitionSchema>;

export function fetchCompetition(api: ApiClient, locationId: string, theme: 'light' | 'dark'): Promise<Competition> {
  return api.json(`${locationPath(locationId)}/competition?theme=${theme}`, competitionSchema);
}
