import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { addDays, daysBetween, EARLIEST_DATE, isCalendarDate } from '../locations/dates';
import { coverageSchema, townSchema } from '../schemas';

// The two reads behind Analytics and Home (spec 10.4 sales history, 10.10 calendar), checked against the contract
// in the build plan (8.2 and decision 12). They live here, not in src/portal/api.ts or schemas.ts, so this folder
// owns its shapes; coverageSchema and townSchema are reused by import. `z.object` strips unknown keys.

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

/** The stored file kinds (spec 6.11). A kind this client doesn't know reads as `other`. */
export const FILE_KINDS = ['text', 'xlsx', 'xls', 'pdf', 'docx', 'doc', 'zip', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** The upload that last wrote a day. `file` stays null until stored files are linked; `name` is null under view-as. */
export const historyUploadSchema = z.object({
  id: z.string(),
  uploadedAt: z.string(),
  uploadedByEmail: z.string(),
  status: z.enum(['applying', 'applied']),
  firstDate: z.string(),
  lastDate: z.string(),
  file: z.object({ id: z.string(), name: z.string().nullable(), kind: z.enum(FILE_KINDS).catch('other') }).nullable(),
});
export type HistoryUpload = z.infer<typeof historyUploadSchema>;

const historyColumnsSchema = z.object({
  date: z.array(z.string()),
  guests: z.array(z.number().nullable()),
  netSalesCents: z.array(z.number().nullable()),
  /** An index into `uploads`, or -1 when the day's upload record is missing. */
  upload: z.array(z.number().int()),
});

/**
 * GET .../sales/history: every stored day, oldest first, as equal-length columns. A body whose columns differ in
 * length, whose dates are not ascending real dates, or whose upload index points nowhere fails the request, so a
 * page never shows a day matched to the wrong figure.
 */
export const salesHistorySchema = z.object({
  coverage: coverageSchema,
  /** True when no day shows because every upload holding days is turned off (D28). Optional for an API from before it. */
  uploadsOff: z.boolean().optional(),
  days: historyColumnsSchema,
  uploads: z.array(historyUploadSchema),
}).superRefine((body, ctx) => {
  const { date, guests, netSalesCents, upload } = body.days;
  const length = date.length;
  if (guests.length !== length || netSalesCents.length !== length || upload.length !== length) {
    ctx.addIssue({ code: 'custom', message: 'history columns differ in length' });
    return;
  }
  for (let index = 0; index < length; index += 1) {
    const day = date[index] ?? '';
    const previous = index === 0 ? null : (date[index - 1] ?? '');
    if (!isCalendarDate(day) || (previous !== null && previous >= day)) {
      ctx.addIssue({ code: 'custom', message: 'history dates are not ascending calendar dates' });
      return;
    }
    const at = upload[index] ?? -1;
    if (at < -1 || at >= body.uploads.length) {
      ctx.addIssue({ code: 'custom', message: 'history upload index out of range' });
      return;
    }
  }
});
export type SalesHistory = z.infer<typeof salesHistorySchema>;

export const EVENT_KINDS = ['holiday', 'event', 'term', 'season'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const sourceSchema = z.object({ label: z.string(), url: z.string() });

/** A web link: http or https. A regex, so the check does not lean on each platform's `URL` support. */
const WEB_LINK = /^https?:\/\//i;

/**
 * Spec 10.10 TownEvent. `start` and `end` are inclusive; `group` names a recurring kind of day, for drivers. A
 * source whose url is not an http or https link is dropped, so no page renders it as a link.
 */
export const townEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  kind: z.enum(EVENT_KINDS),
  scope: z.enum(['national', 'observance', 'town']), // observance: a holiday no law sets (Halloween, D68)
  group: z.string().nullable(),
  groupLabel: z.string().nullable(),
  sources: z.array(sourceSchema).transform((sources) => sources.filter((source) => WEB_LINK.test(source.url))),
});
export type TownEvent = z.infer<typeof townEventSchema>;

/** A secure web link: https only (D66 design decision 15), so a found event's source never renders another scheme. */
const SECURE_LINK = /^https:\/\/\S+$/i;

/**
 * Spec 10.10's `found` item (D66, town research): an event the research agent found, as this location sees it after
 * its revisions. `head` is what an edit sends as `basedOn`. `weekdays` are 0 (Sunday) to 6. A source whose url is not
 * an https link is dropped, and the event keeps its others.
 */
export const researchedEventSchema = z.object({
  id: z.string().regex(/^[tl]-[0-9a-f]{24}$/),
  head: z.string().min(1),
  title: z.string(),
  start: z.string().refine(isCalendarDate),
  end: z.string().refine(isCalendarDate),
  weekdays: z.array(z.number().int().min(0).max(6)).nullable(),
  startTime: z.string().nullable(),
  kind: z.enum(['event', 'season', 'closure']),
  category: z.string(),
  status: z.enum(['scheduled', 'cancelled', 'postponed']),
  origin: z.enum(['town', 'neighborhood', 'competitor', 'town_overview']),
  confidence: z.enum(['high', 'medium', 'low']),
  where: z.string().nullable(),
  who: z.string().nullable(),
  competitor: z.object({ entityId: z.string().nullable(), placeId: z.string().nullable() }).nullable(),
  sources: z.array(sourceSchema).transform((sources) => sources.filter((source) => SECURE_LINK.test(source.url))),
  lastSeenAt: z.string(),
  edited: z.boolean(),
}).refine((event) => event.start <= event.end);
export type ResearchedEvent = z.infer<typeof researchedEventSchema>;

/**
 * `found` read item by item: an item this client can't read is left out and the others kept. An API from before D66
 * has no `found` and reads `[]`; `null` (the API's researched read failed) stays null, read as unavailable.
 */
export const foundSchema = z.unknown().optional().transform((value): ResearchedEvent[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = researchedEventSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
});

/** GET .../calendar. `covers` is the span of the town's researched events (all years), null when there are none. */
export const calendarSchema = z.object({
  town: townSchema,
  researched: z.boolean(),
  covers: z.object({ from: z.string(), to: z.string() }).nullable(),
  events: z.array(townEventSchema),
  found: foundSchema,
});
export type Calendar = z.infer<typeof calendarSchema>;

export function fetchSalesHistory(api: ApiClient, locationId: string): Promise<SalesHistory> {
  return api.json(`${locationPath(locationId)}/sales/history`, salesHistorySchema);
}

/** Events and holidays overlapping `from` to `to`, inclusive. */
export function fetchCalendar(api: ApiClient, locationId: string, range: { from: string; to: string }): Promise<Calendar> {
  return api.json(`${locationPath(locationId)}/calendar?from=${range.from}&to=${range.to}`, calendarSchema);
}

/** The API's calendar span: fewer than 7,320 days, from 2010-01-01, ending at most 400 days after its day. */
const MAX_CALENDAR_DAYS = 7319;

/**
 * The calendar range a page asks for: January 1 of the first year with data (this year with no data) to December 31
 * of this year, kept inside the API's rules so the request is never refused.
 */
export function calendarRange(firstDate: string | null, today: string): { from: string; to: string } {
  const year = today.slice(0, 4);
  const to = `${year}-12-31`;
  const firstYear = (firstDate ?? today).slice(0, 4);
  let from = `${firstYear < year ? firstYear : year}-01-01`;
  if (from < EARLIEST_DATE) from = EARLIEST_DATE;
  if (daysBetween(from, to) > MAX_CALENDAR_DAYS) from = addDays(to, -MAX_CALENDAR_DAYS);
  return { from, to };
}
