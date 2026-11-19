import { OWNER_CAUSES, type ForecastMadeItem, type OwnerCause } from '../../src/chat/api';
import { CAUSE_WORDS, runCauseText, runDaysText, runDetailLine, runOutcomeLine } from '../../src/chat/forecastRuns';
import { activityLine } from '../../src/chat/ui/AgentSidePanel';
import { OWNER_REASONS, type OwnerReason } from '../../src/portal/schemas';

// D65 (openspec change forecast-training-status, design decision 7): a finished forecast run in the owner's words.
// Every reason has a later-run and a first-forecast sentence; a first forecast never mentions a current forecast or
// says it didn't change; `staff` is a staff start by any route; `sales` never says the owner uploaded; no sentence
// states a minimum history or promises a retry; the only figures are day counts and dates. Made-up days.

function run(fields: Partial<ForecastMadeItem> = {}): ForecastMadeItem {
  return {
    at: '2026-11-16T09:20:00.000Z', kind: 'forecast_made', calibrationId: '0000000000000000000000e7', causes: ['weekly'],
    outcome: 'kept', reason: 'not_more_accurate', firstForecast: false, dayCount: 1035, firstDate: '2024-01-01', lastDate: '2026-11-15',
    newDays: 6, ...fields,
  };
}

const LATER: Readonly<Record<OwnerReason, string>> = {
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

const FIRST: Readonly<Record<OwnerReason, string>> = {
  published: 'Your first forecast was published.',
  published_by_staff: 'Your first forecast was published by Townwise staff after a review.',
  not_more_accurate: 'Not published: it wasn’t accurate enough on the weeks it was tested on.',
  not_beat_average: 'Not published: it wasn’t more accurate than a simple weekday average.',
  failed_checks: 'Not published: it didn’t pass Townwise’s accuracy checks.',
  held_for_review: 'Not published yet: it differs a lot from your last forecast, so Townwise staff check it first.',
  too_soon: 'Not published yet: there weren’t enough weeks to test it on.',
  needs_more_history: 'Not published yet: Townwise needs more history.',
  forecasts_off: 'Not published: forecasts are off for your organization.',
  newer_forecast: 'Not used: a newer forecast was published while it ran.',
  staff_withdrew: 'Not used: Townwise staff withdrew it before it was published.',
  not_judged: 'Not used: it matched a forecast Townwise had already made.',
  failed: 'Couldn’t run, so there’s no forecast yet.',
};

describe('the outcome sentence', () => {
  test.each(OWNER_REASONS)('%s has a later-run and a first-forecast sentence, and the activity line is it', (reason) => {
    expect(runOutcomeLine(run({ reason }))).toBe(LATER[reason]);
    expect(runOutcomeLine(run({ reason, firstForecast: true }))).toBe(FIRST[reason]);
    expect(activityLine(run({ reason, firstForecast: true }))).toBe(FIRST[reason]);
  });

  test('no first-forecast sentence mentions a current forecast or says it didn’t change: there was none', () => {
    for (const reason of OWNER_REASONS) {
      const line = runOutcomeLine(run({ reason, firstForecast: true }));
      expect(line).not.toMatch(/current/i);
      expect(line).not.toMatch(/didn’t change/);
    }
  });

  test('no sentence states a minimum history, promises a retry or uses the staff words', () => {
    for (const reason of OWNER_REASONS) {
      for (const firstForecast of [false, true]) {
        const line = runOutcomeLine(run({ reason, firstForecast }));
        expect(line).not.toMatch(/\d/);
        expect(line).not.toMatch(/try again|retry|tries again|will run/i);
        // GATE_WORDS and FAILURE_WORDS are staff words: drafts staff review.
        expect(line).not.toMatch(/draft/i);
      }
    }
  });
});

describe('what started it', () => {
  test('every cause has its words; a staff start (by any route) reads as staff, an org admin’s as the team’s', () => {
    expect(OWNER_CAUSES.map((cause) => runCauseText([cause]))).toEqual([
      'Weekly refresh', 'After new sales history was added', 'After your notes or rules changed', 'After TownwiseAI’s changes',
      'Asked for by your team', 'Started by Townwise staff', 'Scheduled refresh',
    ]);
  });

  test('sales history added by staff setup is worded so it never says the owner uploaded it', () => {
    expect(CAUSE_WORDS.sales).not.toMatch(/upload|your sales/i);
  });

  test('several causes read as one list, and none reads as nothing', () => {
    expect(runCauseText(['sales', 'person_change'])).toBe('After new sales history was added and after your notes or rules changed');
    expect(runCauseText(['sales', 'person_change', 'townwise_ai'])).toBe(
      'After new sales history was added, after your notes or rules changed and after TownwiseAI’s changes',
    );
    expect(runCauseText([])).toBeNull();
  });
});

describe('the days it used', () => {
  test('the count, the range and the new days', () => {
    expect(runDaysText(run())).toBe('1,035 days, Jan 1, 2024 to Nov 15, 2026, 6 new');
    expect(runDaysText(run({ dayCount: 1, firstDate: '2026-11-15', lastDate: '2026-11-15', newDays: 1 }))).toBe('1 day, Nov 15, 2026, 1 new');
    expect(runDaysText(run({ newDays: 0 }))).toBe('1,035 days, Jan 1, 2024 to Nov 15, 2026, no new days');
    // A first forecast: no published run to count new days after.
    expect(runDaysText(run({ dayCount: 412, firstDate: '2025-03-01', lastDate: '2026-05-31', newDays: null }))).toBe('412 days, Mar 1, 2025 to May 31, 2026');
  });

  test('a run from before D65, or one that failed before reading its days, states none', () => {
    expect(runDaysText(run({ dayCount: null, firstDate: null, lastDate: null, newDays: null }))).toBeNull();
    expect(runDetailLine(run({ dayCount: null, firstDate: null, lastDate: null, newDays: null }))).toBe('Weekly refresh.');
    expect(runDetailLine(run({ causes: [], dayCount: null }))).toBeNull();
  });

  test('the small line is the cause, then the days', () => {
    expect(runDetailLine(run())).toBe('Weekly refresh. 1,035 days, Jan 1, 2024 to Nov 15, 2026, 6 new.');
  });
});

test('no digit in any line but its day counts and dates', () => {
  const days = run({ dayCount: 1035, firstDate: '2024-01-01', lastDate: '2026-11-15', newDays: 6 });
  for (const reason of OWNER_REASONS) {
    for (const firstForecast of [false, true]) {
      for (const cause of OWNER_CAUSES) {
        const causes: OwnerCause[] = [cause];
        const item = { ...days, reason, firstForecast, causes };
        const text = `${runOutcomeLine(item)} ${runDetailLine(item) ?? ''}`
          .replace('1,035 days', '').replace('Jan 1, 2024 to Nov 15, 2026', '').replace('6 new', '');
        expect(text).not.toMatch(/\d/);
      }
    }
  }
});
