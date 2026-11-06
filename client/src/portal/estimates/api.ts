import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The two estimate reads (spec 10.13, docs/portal/estimates.md): people in town for a range of days, and "How Townwise
// estimates" for a location. Their shapes live here, not in src/portal/schemas.ts, so this folder owns them.
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
  /** Null until staff publish a forecast for the location; the run state arrives with forecast runs. */
  forecast: z.object({ run: z.null(), live: z.null() }),
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
