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
  /** 'model' or 'baseline' (D42), any string so an engine this client doesn't know never fails the card; missing from an API before it. */
  engine: z.string().optional(),
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

/** What a note or a business rule did to a forecast day: its id, guest count and outcome (spec 14.5). */
const appliedSchema = z.object({ id: z.string(), guests: z.number().nullable(), outcome: z.string() });

/**
 * Whether a reason usually brings more or fewer guests (spec 14.4): `pct` is its size rounded to the nearest 5 (never
 * negative), 'same' at 5 or less; `basis` 'model' is the run's own effect, 'history' how the location's own last 52
 * weeks usually ran over `days` days (null for the model's). `averageGuests`, on a weekday's history effect, is the
 * average open day's guests it is held against; null on every other, missing from an API before it.
 */
const reasonEffectSchema = z.object({
  direction: z.enum(['more', 'fewer', 'same']),
  pct: z.number(),
  basis: z.enum(['model', 'history']),
  days: z.number().nullable(),
  averageGuests: z.number().nullish(),
});
export type ReasonEffect = z.infer<typeof reasonEffectSchema>;

/**
 * A reason a forecast day gives. `kind` is any string, so a kind this client doesn't know never fails a page; 'note'
 * is one of the location's notes, which the API words from its kind, guests and hours (never its detail), with what it
 * did to the day in `note.outcome` (spec 14.5); 'rule' is a business rule with a schedule (D31), worded from the
 * schedule (never the rule's text), with what it did in `rule.outcome` (missing from an API before rules). A source
 * whose url is not a web link is dropped. `effect` is set from the town's today on, null when there is nothing honest
 * to say, missing from an API before effects; one this client can't read is null, so it never fails a page.
 */
const forecastReasonSchema = z.object({
  kind: z.string(),
  label: z.string(),
  effectPct: z.number().nullable(),
  effect: reasonEffectSchema.nullish().catch(null),
  sources: z.array(z.object({ label: z.string(), url: z.string() })).transform((sources) => sources.filter((source) => WEB_LINK.test(source.url))),
  note: appliedSchema.nullable(),
  rule: appliedSchema.nullish(),
});
export type ForecastReason = z.infer<typeof forecastReasonSchema>;

/** The note's or the rule's part of a reason: what it did to the day; null on the run's own reasons. */
export function appliedOf(reason: ForecastReason): z.infer<typeof appliedSchema> | null {
  return reason.note ?? reason.rule ?? null;
}

/** Whether a note or a business rule on the day had this outcome. */
export function yoursDid(day: Pick<ForecastDay, 'reasons'>, outcome: string): boolean {
  return day.reasons.some((reason) => appliedOf(reason)?.outcome === outcome);
}

/**
 * Whose guests a day's `noteGuests` are, from the reasons that added or booked them: “your rules”, “your notes and
 * rules”, else “your notes” (also when the API left the notes past its first six out of the reasons).
 */
export function guestsFromWords(day: Pick<ForecastDay, 'reasons'>): 'your notes' | 'your rules' | 'your notes and rules' {
  const counted = (outcome: string | undefined): boolean => outcome === 'added' || outcome === 'booked';
  const notes = day.reasons.some((reason) => counted(reason.note?.outcome));
  const rules = day.reasons.some((reason) => counted(reason.rule?.outcome));
  if (rules) return notes ? 'your notes and rules' : 'your rules';
  return 'your notes';
}

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
  /** Rule reasons past the first 6 (D31); an older answer has none. */
  moreRules: z.number().optional(),
  reasons: z.array(forecastReasonSchema),
  runId: z.string(),
  actual: z.number().nullable(),
  inRange: z.boolean().nullable(),
  /** Counted in the window's `accuracy` (open in the model, not closed, likely closed or booked, with guests); missing from an API before it. */
  scored: z.boolean().optional(),
  /** After its run's forecast tier (D52): Townwise's outlook, with a wider range and no 8 in 10 claim; false from an API before it. */
  outlook: z.boolean().default(false),
});
export type ForecastDay = z.infer<typeof forecastDaySchema>;

/**
 * GET .../forecast (spec 10.13, 14.5). `available` is false when no published run covers any day of the range. A week a
 * note changed the status of is left out; another week's figures include `noteGuests` (0 from an API before notes).
 */
export const forecastWindowSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['no_published_forecast', 'not_covered']).nullable(),
  runs: z.array(z.object({
    id: z.string(), model: z.object({ label: z.string() }), engine: z.string().optional(), madeAt: z.string(), live: liveAccuracySchema.nullable(),
    /** The run's backtest; Home reads its weekly 80% band, as percents below and above a week's total (D43). */
    backtest: z.object({ weeklyRangePct: z.object({ below: z.number(), above: z.number() }).nullable() }).nullable().optional(),
  })),
  days: z.array(forecastDaySchema),
  /** Live accuracy over the window's own scored days, each from its own run (D42); null under 5, missing from an API before it. */
  accuracy: liveAccuracySchema.nullable().optional(),
  weeks: z.array(z.object({
    from: z.string(), to: z.string(), openDays: z.number(), low: z.number(), mid: z.number(), high: z.number(), runId: z.string(),
    noteGuests: z.number().default(0),
    /** Any of its days is an outlook day (D52); false from an API before it. */
    outlook: z.boolean().default(false),
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

/** The published forecast from `from` to `to`, inclusive, at most 92 days (the API's rule, D42); the Calendar reads six-week grids. */
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
