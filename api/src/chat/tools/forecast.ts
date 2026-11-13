// get_forecast (U13B, spec 14.4): Townwise's published forecast of guests for a range of at most 31 days, read through
// ctx.ports.forecasts, so a draft or withdrawn run never reaches the model. Each day and whole week comes as an 80%
// range (low rounded down, high up, mid to the nearest guest, so the model never repeats a falsely exact figure),
// with the reasons the run recorded in code-made words, and for each run the days came from its version, training
// range, made-at date and its own accuracy (backtest, and live over the days it supplied, misses included), so a
// newer run is never credited with an older one's days; and how past days compared with what happened. From the town's
// today on, each day already includes the owner's saved notes (forecasts/adjust.ts, spec 14.5): modelRange is the model's
// own figures when a note changed them, noteGuests the guests notes add, and a note's reason gives its guest count and
// what it did, never its detail or id. A business rule with a schedule (D31) applies the same way, as a rule reason with
// its guest count and outcome, never the rule's text or id. From today on each run reason carries its effect (forecasts/effects.ts):
// the model's where the run recorded one, otherwise how the location's own last 52 weeks usually ran, which the model
// words as "usually", never as the forecast's cause. With no published forecast it says so, and what to use instead. The model, its features, its training rows, the run file and staff ids never
// reach the API, so they cannot reach the model either.
import { z } from 'zod';

import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { MODEL_CARD } from '../../estimates/about.ts';
import type { ForecastDayView, ForecastWindow, ForecastWindowRun } from '../../forecasts/reader.ts';
import type { ChatTool } from './registry.ts';
import { DATE, viewOf } from './shared.ts';

/** How many days a range covers at most, both ends included: the tool's own, under the forecast route's 42. */
const MAX_RANGE_DAYS = 31;
/** How far back a range may start: about a quarter, so recent misses can be discussed. */
const MAX_DAYS_BACK = 92;
const MAX_DAYS_AHEAD = 400;

export const NO_FORECAST = 'Townwise has no forecast for this location yet.';
export const NOT_COVERED = 'Townwise has no forecast for these dates.';
export const USE_INSTEAD = 'the location\'s history and the town calendar';
/** The 80% belongs to the model's own figures (spec 14.5): a range that a note's guests moved is not an 80% range. */
export const INTERVAL_MEANING = 'About 8 in 10 days should land inside the model\'s own range: a day\'s modelRange when a note changed it, otherwise its low to high. A range that includes guests from notes is not the model\'s.';

const TRAINED_ON: Readonly<Record<ForecastWindowRun['trainingSource'], string>> = {
  files_from_owner: 'sales exports the owner sent Townwise',
  townwise_lab: 'the sales history and notes the owner uploaded to Townwise',
};

export interface ForecastRange { from: string; to: string }

function rangeSchema(today: string) {
  const at = new Date(`${today}T00:00:00.000Z`);
  return z.object({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from >= utcDay(at, -MAX_DAYS_BACK)
    && range.from <= range.to && daysBetween(range.from, range.to) < MAX_RANGE_DAYS && range.to <= utcDay(at, MAX_DAYS_AHEAD));
}

const low = (value: number) => Math.floor(value);
const mid = (value: number) => Math.round(value);
const high = (value: number) => Math.ceil(value);

/** One run with its own accuracy: the backtest, and live over the passed days it supplied. */
function modelOf(run: ForecastWindowRun) {
  return {
    label: run.model.label, version: run.model.version, trainedOn: TRAINED_ON[run.trainingSource], trainedFrom: run.trainedFrom,
    dataThrough: run.dataThrough, madeAt: run.madeAt, frozen: run.frozen, rangesWidened: run.interval.widened,
    accuracy: { backtest: run.backtest, live: run.live },
  };
}

/** A day's figures rounded for speech: low down, mid to the nearest guest, high up. */
function rounded(figures: Pick<ForecastDayView, 'status' | 'low' | 'mid' | 'high'>) {
  return {
    status: figures.status,
    low: figures.low === null ? null : low(figures.low), mid: figures.mid === null ? null : mid(figures.mid), high: figures.high === null ? null : high(figures.high),
  };
}

/** The model's own figures for the day, or null when no note changed them. */
function modelRangeOf(day: ForecastDayView) {
  const shown = rounded(day);
  const model = rounded(day.model);
  const same = shown.status === model.status && shown.low === model.low && shown.mid === model.mid && shown.high === model.high;
  return same ? null : model;
}

/** What the model reads: the window rounded for speech, every label made in code. */
export function forecastContent(window: ForecastWindow): Record<string, unknown> {
  if (!window.available) {
    return {
      available: false,
      reason: window.reason === 'not_covered' ? NOT_COVERED : NO_FORECAST,
      useInstead: USE_INSTEAD,
      ...(window.reason === 'not_covered' ? { notCovered: window.notCovered } : {}),
    };
  }
  const [newest] = window.runs;
  return {
    available: true,
    metric: 'guests',
    model: newest === undefined ? null : modelOf(newest),
    ...(window.runs.length > 1 ? { earlierModels: window.runs.slice(1).map(modelOf) } : {}),
    interval: { level: 0.8, meaning: INTERVAL_MEANING },
    days: window.days.map((day) => ({
      date: day.date, weekday: day.weekday, ...rounded(day),
      vsBaselinePct: day.baseline === null || day.baseline <= 0 || day.mid === null ? null : Math.round(100 * (day.mid / day.baseline - 1)),
      reasons: day.reasons.map((reason) => ({
        label: reason.label, effectPct: reason.effectPct, effect: reason.effect, sources: reason.sources.map((source) => source.url),
        note: reason.note === null ? null : { guests: reason.note.guests, outcome: reason.note.outcome },
        rule: reason.rule === null ? null : { guests: reason.rule.guests, outcome: reason.rule.outcome },
      })),
      modelRange: modelRangeOf(day), noteGuests: day.noteGuests,
      madeAt: day.madeAt, madeAfterDay: day.madeAfterDay, actual: day.actual, inRange: day.inRange,
    })),
    weeks: window.weeks.map((week) => ({
      from: week.from, to: week.to, openDays: week.openDays, low: low(week.low), mid: mid(week.mid), high: high(week.high),
      noteGuests: week.noteGuests, madeAt: week.madeAt, actual: week.actual, inRange: week.inRange,
    })),
    notCovered: window.notCovered,
    about: { inputs: MODEL_CARD.inputs, cannotSee: MODEL_CARD.cannotSee, limits: MODEL_CARD.limits },
  };
}

const forecastResult = z.object({
  available: z.boolean(),
  model: z.object({ version: z.string(), madeAt: z.string(), dataThrough: z.string() }).nullable().optional(),
  days: z.array(z.unknown()).optional(),
  notCovered: z.array(z.unknown()).optional(),
});

export const forecastTool: ChatTool<ForecastRange> = {
  definition: {
    name: 'get_forecast',
    description: 'Townwise\'s published forecast of guests per day for a date range of at most 31 days (both ends included, starting at most 92 days before today), with an 80% range for each day and for whole weeks, the reasons the model recorded, each model\'s version, training range and made-at date with its own accuracy in backtests and so far (over the days it supplied), and how past forecast days compared with what happened (actual and inRange). A booked day is a private buyout with no walk-in range. From today on, each day includes the owner\'s saved notes: a closure closes the day; otherwise a buyout books it, even a day the model expects closed; a private event with a guest count adds its guests, and opens a day the model expects closed with only those guests. modelRange is the model\'s own figures when a note changed them. The owner\'s business rules with a schedule apply the same way, each as a reason with rule set in place of note. A note or rule reason\'s outcome says what it did: added, booked, closed, already_in_forecast (the model counted the event already), no_guest_count, not_counted (only private events change numbers), day_closed (the day stays closed), day_booked (the day is booked) or past_day. From today on, each other reason carries effect { direction: more, fewer or same, pct (rounded to the nearest 5; same at 5 or less), basis, days }: basis model is the effect the model recorded; basis history is how this location\'s own last 52 weeks usually ran, closed and likely-closed days left out, over days days: a weekday against the average open day, a term state against the same weekday in other term states, a holiday against the same weekday in the 4 weeks around it, an event against the same weekday without it. A history effect is not why the model made its figure. Say "usually" ("Saturdays usually bring about 35% more guests than your average day"), and say how few days it rests on when they are few. effect is null before today, on a note or rule reason, and when the history is too short to say, which you say plainly. vsBaselinePct is set only when the model recorded its usual level for the day. Says when no forecast exists, and what to use instead.',
    input_schema: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: from and to are YYYY-MM-DD dates, from on or before to, at most 31 days apart counting both ends, from at most 92 days before today and to at most 400 days after it.',
  parse(raw, today) {
    const range = rangeSchema(today).safeParse(raw);
    return range.success ? { from: range.data.from, to: range.data.to } : null;
  },
  inputView: (range) => ({ from: range.from, to: range.to }),
  resultView: (content) => viewOf(content, forecastResult, ({ available, model, days, notCovered }) => ({
    available,
    modelVersion: model?.version ?? null,
    madeAt: model?.madeAt ?? null,
    dataThrough: model?.dataThrough ?? null,
    days: days?.length ?? 0,
    notCovered: notCovered?.length ?? 0,
  })),
  async run(tc, range) {
    const window = await tc.ctx.ports.forecasts.window(tc.scope, tc.location, range, tc.today);
    return { content: JSON.stringify(forecastContent(window)) };
  },
};
