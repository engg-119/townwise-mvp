import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The estimate reads (spec 10.13, docs/portal/estimates.md): people in town for a range of days, "How Townwise
// estimates" for a location, and the published forecast for a range of days (the one client read of it, which the
// Calendar, Home and TownwiseAI's pages share). Their shapes live here, not in src/portal/schemas.ts, so this folder owns them.
// `z.object` strips unknown keys, so a field the API adds later never breaks a page.

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const TERM_STATES = ['in_session', 'finals', 'between_terms', 'summer_session', 'unknown'] as const;
export type TermState = (typeof TERM_STATES)[number];

const confidenceSchema = z.enum(['high', 'medium', 'low']);

const periodSchema = z.object({
  from: z.string(),
  to: z.string(),
  fromWeekday: z.enum(WEEKDAYS),
  toWeekday: z.enum(WEEKDAYS),
  termState: z.enum(TERM_STATES),
  termLabel: z.string().nullable(),
  termSourceIds: z.array(z.string()),
  headcount: z.object({ low: z.number(), high: z.number(), sourceIds: z.array(z.string()), excludes: z.array(z.string()) }).nullable(),
  headcountWhy: z.enum(['no_population', 'visitors_unknown', 'no_term_dates', 'no_enrollment']).nullable(),
  events: z.array(z.object({
    id: z.string(), title: z.string(), kind: z.enum(['event', 'holiday']), attendanceHigh: z.number().nullable(), sourceIds: z.array(z.string()),
  })),
});
export type PeoplePeriod = z.infer<typeof periodSchema>;

const historySchema = z.object({
  metric: z.enum(['guests', 'netSales']),
  /** mean: whole guests, or whole US dollars of net sales; null under 3 days. */
  cells: z.array(z.object({ state: z.enum(TERM_STATES), weekday: z.enum(WEEKDAYS), days: z.number(), mean: z.number().nullable() })),
  first: z.string().nullable(),
  last: z.string().nullable(),
});
export type YourHistory = z.infer<typeof historySchema>;

export const peopleInTownSchema = z.object({
  available: z.boolean(),
  reason: z.literal('town_not_researched').nullable(),
  from: z.string(),
  to: z.string(),
  town: z.object({ name: z.string(), state: z.string(), kind: z.enum(['college', 'seasonal', 'event']).nullable() }),
  timeZone: z.string(),
  periods: z.array(periodSchema),
  season: z.array(z.object({
    month: z.string(), countyFoodServiceJobsIndex: z.number(), baseYear: z.number(), county: z.string(), sourceIds: z.array(z.string()),
  })),
  visitors: z.array(z.object({ month: z.string(), label: z.string(), perDayAverage: z.number(), sourceIds: z.array(z.string()) })),
  yourHistory: historySchema,
  sources: z.array(z.object({ id: z.string(), label: z.string(), url: z.string(), confidence: confidenceSchema.nullable() })),
  caveats: z.array(z.string()),
});
export type PeopleInTown = z.infer<typeof peopleInTownSchema>;

/** U13B: the newest published forecast run, as the model card shows it (spec 14.4). */
export const forecastRunSchema = z.object({
  id: z.string(),
  metric: z.literal('guests'),
  model: z.object({ family: z.string(), version: z.string(), label: z.string() }),
  // Any string: a source this client doesn’t know yet reads as sales history (trainedOnWords), never fails the card.
  trainingSource: z.string(),
  trainedFrom: z.string(),
  dataThrough: z.string(),
  madeAt: z.string(),
  frozen: z.boolean(),
  interval: z.object({ level: z.literal(0.8), widened: z.boolean() }),
  backtest: z.object({
    from: z.string(), to: z.string(), weeks: z.number(), weeklyTypicalErrorPct: z.number(), weeksOver20Pct: z.number(),
  }).nullable(),
});
export type ForecastRun = z.infer<typeof forecastRunSchema>;

// A Map, so a source named like an Object.prototype key ("constructor") still reads as sales history.
const TRAINED_ON: ReadonlyMap<string, string> = new Map([
  ['files_from_owner', 'sales exports you sent Townwise'],
  ['townwise_lab', 'sales history and notes you uploaded to Townwise'],
]);

/** What a run was trained on, in words; a source this client doesn’t know reads as sales history. */
export function trainedOnWords(trainingSource: string): string {
  return TRAINED_ON.get(trainingSource) ?? 'sales history';
}

/** U13B: how the published days compared with what happened; null under 5 scored days. */
export const liveAccuracySchema = z.object({
  days: z.number(), inRange: z.number(), typicalErrorPct: z.number().nullable(), from: z.string(), to: z.string(),
});
export type LiveAccuracy = z.infer<typeof liveAccuracySchema>;

const DAY_STATUSES = ['open', 'closed', 'booked'] as const;

/** A web link: http or https. A regex, so the check does not lean on each platform's `URL` support. */
const WEB_LINK = /^https?:\/\//i;

/**
 * A reason a forecast day gives. `kind` is any string, so a kind this client doesn't know never fails a page; 'note'
 * is one of the location's notes, which the API words from its kind, guests and hours (never its detail), with what it
 * did to the day in `note.outcome` (spec 14.5). A source whose url is not a web link is dropped.
 */
const forecastReasonSchema = z.object({
  kind: z.string(),
  label: z.string(),
  effectPct: z.number().nullable(),
  sources: z.array(z.object({ label: z.string(), url: z.string() })).transform((sources) => sources.filter((source) => WEB_LINK.test(source.url))),
  note: z.object({ id: z.string(), guests: z.number().nullable(), outcome: z.string() }).nullable(),
});
export type ForecastReason = z.infer<typeof forecastReasonSchema>;

/**
 * A published forecast day. `status`, `low`, `mid` and `high` are the day as the location's notes leave it from the
 * town's today on; `model` is the run's own (its range is the 80% one), equal to the day's when no note changed it.
 * `noteGuests`: guests notes add to an open day, or a buyout's party on a booked day. `moreNotes`: note reasons past
 * the first 6. `inRange` is always the model's.
 */
const forecastDaySchema = z.object({
  date: z.string(),
  status: z.enum(DAY_STATUSES),
  low: z.number().nullable(),
  mid: z.number().nullable(),
  high: z.number().nullable(),
  model: z.object({ status: z.enum(DAY_STATUSES), low: z.number().nullable(), mid: z.number().nullable(), high: z.number().nullable() }),
  noteGuests: z.number(),
  moreNotes: z.number(),
  reasons: z.array(forecastReasonSchema),
  runId: z.string(),
  actual: z.number().nullable(),
  inRange: z.boolean().nullable(),
});
export type ForecastDay = z.infer<typeof forecastDaySchema>;

/**
 * GET .../forecast (spec 10.13, 14.5). `available` is false when no published run covers any day of the range. A week a
 * note changed the status of is left out; another week's figures include `noteGuests` (0 from an API before notes).
 */
export const forecastWindowSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['no_published_forecast', 'not_covered']).nullable(),
  runs: z.array(z.object({ id: z.string(), model: z.object({ label: z.string() }), madeAt: z.string(), live: liveAccuracySchema.nullable() })),
  days: z.array(forecastDaySchema),
  weeks: z.array(z.object({
    from: z.string(), to: z.string(), openDays: z.number(), low: z.number(), mid: z.number(), high: z.number(), runId: z.string(),
    noteGuests: z.number().default(0),
  })),
});
export type ForecastWindow = z.infer<typeof forecastWindowSchema>;

export const estimatesAboutSchema = z.object({
  version: z.string(),
  card: z.object({
    estimates: z.string(),
    inputs: z.array(z.string()),
    cannotSee: z.array(z.string()),
    limits: z.array(z.string()),
    checked: z.string(),
    whoCanSee: z.string(),
  }),
  location: z.object({ name: z.string(), town: z.object({ name: z.string(), state: z.string() }) }),
  today: z.object({ date: z.string(), weekday: z.enum(WEEKDAYS), timeZone: z.string(), approximate: z.boolean() }),
  /** Null until staff publish a forecast for the location (U13B). */
  forecast: z.object({ run: forecastRunSchema.nullable(), live: liveAccuracySchema.nullable() }),
  calendar: z.object({ researched: z.boolean(), covers: z.object({ from: z.string(), to: z.string() }).nullable() }),
  people: z.object({
    headcountInputs: z.array(z.string()),
    sources: z.array(z.object({ id: z.string(), label: z.string(), url: z.string(), confidence: confidenceSchema })),
  }),
});
export type EstimatesAbout = z.infer<typeof estimatesAboutSchema>;

/** People in town from `from` to `to`, inclusive, at most 92 days. */
export function fetchPeopleInTown(api: ApiClient, locationId: string, range: { from: string; to: string }): Promise<PeopleInTown> {
  return api.json(`${locationPath(locationId)}/people-in-town?from=${range.from}&to=${range.to}`, peopleInTownSchema);
}

/** The published forecast from `from` to `to`, inclusive, at most 31 days (the API's rule). */
export function fetchForecast(api: ApiClient, locationId: string, range: { from: string; to: string }): Promise<ForecastWindow> {
  return api.json(`${locationPath(locationId)}/forecast?from=${range.from}&to=${range.to}`, forecastWindowSchema);
}

export function fetchEstimatesAbout(api: ApiClient, locationId: string): Promise<EstimatesAbout> {
  return api.json(`${locationPath(locationId)}/estimates/about`, estimatesAboutSchema);
}

/** The first and last day of a 'YYYY-MM' month. */
export function monthRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
