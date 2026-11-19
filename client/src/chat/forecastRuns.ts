import { plural } from '../portal/format';
import type { OwnerReason } from '../portal/schemas';
import { FIRST_FORECAST_REASONS } from '../portal/upload/copy';
import type { ForecastMadeItem, OwnerCause } from './api';
import { rangeText } from './format';

// A finished forecast run in TownwiseAI's activity (D65, openspec change forecast-training-status, design decision 7),
// in the owner's words: what happened (the outcome sentence), then what started it, then the days it used. The server
// sends codes only; the staff GATE_WORDS and FAILURE_WORDS say what staff can do about a draft and never show here.
// A first forecast has its own sentence for every reason, built on Home's not-published clauses (FIRST_FORECAST_REASONS),
// so it never mentions a current forecast or says the forecast didn't change: there was none. No sentence states a
// minimum history (14.1) or promises a retry (a cleared refit mark is not retried until new data arrives); Home's notice
// states the next step. `sales` covers staff setup's upload too, so it never says "your upload". Dates and day counts
// are the only figures. Pure: nothing here reads or writes. [CONFIRM: the owner reasons, their later-run and
// first-forecast words, and the cause words]

/** A run after the location's first forecast. */
const LATER_WORDS: Readonly<Record<OwnerReason, string>> = {
  published: 'Published: your forecast uses it now.',
  published_by_staff: 'Published by Townwise staff after a review: your forecast uses it now.',
  not_more_accurate: 'Kept your current forecast: the new one wasn’t more accurate on the weeks it was tested on.',
  not_beat_average: 'Kept your current forecast: the new one wasn’t more accurate than a simple weekday average.',
  failed_checks: 'Kept your current forecast: the new one didn’t pass Townwise’s accuracy checks.',
  held_for_review: 'Kept your current forecast: the new one changed a lot at once, so Townwise staff check it first.',
  too_soon: 'Kept your current forecast: there weren’t enough new weeks to compare yet.',
  needs_more_history: 'Kept your current forecast: Townwise needs more history for this one.',
  forecasts_off: 'Not published: forecasts are off for your organization.',
  newer_forecast: 'Not used: a newer forecast was published while it ran.',
  staff_withdrew: 'Not used: Townwise staff withdrew it before it was published.',
  not_judged: 'Not used: it matched a forecast Townwise had already made.',
  failed: 'Couldn’t run. Your forecast didn’t change.',
};

/** How a first forecast's not-published clause starts: "yet" where staff or more data may still change it. */
const FIRST_LEAD: Readonly<Record<Exclude<keyof typeof FIRST_FORECAST_REASONS, 'failed'>, string>> = {
  not_more_accurate: 'Not published', not_beat_average: 'Not published', failed_checks: 'Not published',
  held_for_review: 'Not published yet', too_soon: 'Not published yet', needs_more_history: 'Not published yet',
  forecasts_off: 'Not published', newer_forecast: 'Not used', staff_withdrew: 'Not used', not_judged: 'Not used',
};

/** What started a run. */
export const CAUSE_WORDS: Readonly<Record<OwnerCause, string>> = {
  weekly: 'Weekly refresh',
  sales: 'After new sales history was added',
  person_change: 'After your notes or rules changed',
  townwise_ai: 'After TownwiseAI’s changes',
  asked: 'Asked for by your team',
  staff: 'Started by Townwise staff',
  unknown: 'Scheduled refresh',
};

/** The outcome sentence: the activity line itself. */
export function runOutcomeLine(item: Pick<ForecastMadeItem, 'reason' | 'firstForecast'>): string {
  if (!item.firstForecast) return LATER_WORDS[item.reason];
  switch (item.reason) {
    case 'published': return 'Your first forecast was published.';
    case 'published_by_staff': return 'Your first forecast was published by Townwise staff after a review.';
    case 'failed': return 'Couldn’t run, so there’s no forecast yet.';
    default: return `${FIRST_LEAD[item.reason]}: ${FIRST_FORECAST_REASONS[item.reason]}`;
  }
}

/** "After new sales history was added and after your notes or rules changed"; null with no cause. */
export function runCauseText(causes: readonly OwnerCause[]): string | null {
  const words = causes.map((cause, index) => (index === 0 ? CAUSE_WORDS[cause] : lowerFirst(CAUSE_WORDS[cause])));
  if (words.length === 0) return null;
  if (words.length === 1) return words[0] ?? null;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/**
 * "1,035 days, Jan 1, 2024 to Nov 15, 2026, 6 new": the history days it used, and how many came after the newest
 * published run's data ("no new days" when none; left out with no published run). Null on a run from before D65 or
 * one that failed before it read its input.
 */
export function runDaysText(item: Pick<ForecastMadeItem, 'dayCount' | 'firstDate' | 'lastDate' | 'newDays'>): string | null {
  if (item.dayCount === null) return null;
  const parts = [plural(item.dayCount, 'day', 'days')];
  if (item.firstDate !== null && item.lastDate !== null) parts.push(rangeText(item.firstDate, item.lastDate));
  if (item.newDays !== null) parts.push(item.newDays === 0 ? 'no new days' : plural(item.newDays, 'new', 'new'));
  return parts.join(', ');
}

/** The small line under the outcome: the cause, then the days; null when neither is known. */
export function runDetailLine(item: ForecastMadeItem): string | null {
  const parts = [runCauseText(item.causes), runDaysText(item)].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `${parts.join('. ')}.`;
}

function lowerFirst(words: string): string {
  return `${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}
