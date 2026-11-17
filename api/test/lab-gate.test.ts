import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { comparisonWith, metricsWith, scorecardWith } from './helpers/lab-scorecard.ts';
import {
  currentChampion, decideGate, engineSwitchOf, GATE, GATE_REASONS, GATE_WORDS, gateWords, jumpSums, streakOf, type CurrentRun, type GateInput,
} from '../src/lab/gate.ts';
import { labResultSchema } from '../src/lab/result.ts';
import type { LabScorecard } from '../src/lab/scorecard.ts';
import { START_REFUSAL_WORDS } from '../src/lab/service.ts';
import type { ForecastRow, ForecastRunRecord } from '../src/stores/forecasts.ts';

/** An imported current run: no recorded lab scorecard, so the draft is compared on held-out weeks (10.15). */
const IMPORTED: CurrentRun = { engine: 'model', recorded: null, streakBest: null };

function withChampion(over: Partial<GateInput> = {}, comparison = comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.19 })): GateInput {
  return {
    forecastsOn: true,
    championAtStart: 'run-a',
    championNow: 'run-a',
    scorecard: scorecardWith({ comparison }),
    current: IMPORTED,
    jump: { draft: 4000, current: 4000 },
    ...over,
  };
}

function first(
  over: Partial<GateInput> = {}, backtest: Partial<LabScorecard['backtest']> = {}, history: Partial<LabScorecard['history']> = {},
): GateInput {
  return {
    forecastsOn: true,
    championAtStart: null,
    championNow: null,
    scorecard: scorecardWith({ comparison: null, backtest, history }),
    current: null,
    jump: null,
    ...over,
  };
}

/** A recorded lab run of `engine` as the current run, with its streak's best recorded backtest weekly WAPE. */
function labCurrent(engine: CurrentRun['engine'], streakBest = 0.091, weekdayBiasMeanAbs = 0.05): CurrentRun {
  return { engine, recorded: { weeklyWape: streakBest, weekdayBiasMeanAbs }, streakBest };
}

/** A draft of `engine` against a recorded lab run: no held-out comparison (the run is a week old). */
function refresh(
  engine: LabScorecard['engine'], current: CurrentRun, backtest: Partial<LabScorecard['backtest']> = {},
  over: Partial<GateInput> = {}, engines?: LabScorecard['engines'],
): GateInput {
  return {
    forecastsOn: true,
    championAtStart: 'run-a',
    championNow: 'run-a',
    scorecard: scorecardWith({ engine, comparison: null, backtest, ...(engines === undefined ? {} : { engines }) }),
    current,
    jump: { draft: 4000, current: 4000 },
    ...over,
  };
}

/** A baseline's backtest: 14 weeks with a range, 11 inside, a bias of -2 points, 11% against the weekday median's 13%. */
const YOUNG: Partial<LabScorecard['backtest']> = {
  weeks: 14, weeksWithRange: 14, metrics: metricsWith({ weeklyWape: 0.11, coverage80: { inside: 11, weeks: 14 } }),
  weekdayMedianWeeklyWape: 0.13, weeklyBias: -0.02,
};

describe('decideGate against an imported current run (held-out weeks, 10.15)', () => {
  it('publishes a challenger 1 point better on 12 weeks with 10 of 12 in range and equal bias', () => {
    expect(decideGate(withChampion())).toEqual({ publish: true, reason: 'published' });
  });

  it('a 0.4 point gain is a tie and does not publish', () => {
    const input = withChampion({}, comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.196 }));
    expect(decideGate(input)).toEqual({ publish: false, reason: 'not_better' });
  });

  it('needs 12 held-out weeks: 11 is too_few_weeks', () => {
    const input = withChampion({}, comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.1 }, 11));
    expect(decideGate(input)).toEqual({ publish: false, reason: 'too_few_weeks' });
    const none = withChampion({ scorecard: scorecardWith({ comparison: null }) });
    expect(decideGate(none).reason).toBe('too_few_weeks');
  });

  it('needs 12 of those weeks with an 80% range from the calibration, however many were compared', () => {
    const at = (coverage80: { inside: number; weeks: number }) =>
      decideGate(withChampion({}, comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.1, coverage80 })));
    expect(at({ inside: 3, weeks: 4 })).toEqual({ publish: false, reason: 'too_few_weeks' });
    expect(at({ inside: 0, weeks: 0 })).toEqual({ publish: false, reason: 'too_few_weeks' });
    expect(at({ inside: 8, weeks: 11 }).reason).toBe('too_few_weeks');
    expect(at({ inside: 9, weeks: 12 })).toEqual({ publish: true, reason: 'published' });
  });

  it('coverage 7 of 12 and 12 of 12 are out of band; 8 of 12 and 11 of 12 pass', () => {
    const at = (inside: number) =>
      decideGate(withChampion({}, comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.19, coverage80: { inside, weeks: 12 } })));
    expect(at(7).reason).toBe('coverage_out_of_band');
    expect(at(12).reason).toBe('coverage_out_of_band');
    expect(at(8).publish).toBe(true);
    expect(at(11).publish).toBe(true);
  });

  it('weekday bias 2.01 points worse refuses; exactly 2 points worse passes', () => {
    const at = (bias: number) =>
      decideGate(
        withChampion({}, comparisonWith({ weeklyWape: 0.2, weekdayBiasMeanAbs: 0.05 }, { weeklyWape: 0.19, weekdayBiasMeanAbs: bias })),
      );
    expect(at(0.0701)).toEqual({ publish: false, reason: 'weekday_bias_worse' });
    expect(at(0.05 + 0.02).publish).toBe(true);
  });

  it('a baseline draft against an imported run is compared the same way', () => {
    const scorecard = scorecardWith({ engine: 'baseline', comparison: comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.19 }) });
    expect(decideGate(withChampion({ scorecard }))).toEqual({ publish: true, reason: 'published' });
  });

  it('a passing draft stays a draft when forecasts are off', () => {
    expect(decideGate(withChampion({ forecastsOn: false }))).toEqual({ publish: false, reason: 'forecasts_off' });
  });

  it('forecasts_off is checked last', () => {
    const input = withChampion({ forecastsOn: false }, comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.2 }));
    expect(decideGate(input).reason).toBe('not_better');
  });

  it('a changed champion never publishes, even when better', () => {
    expect(decideGate(withChampion({ championNow: 'run-b' }))).toEqual({ publish: false, reason: 'champion_changed' });
    expect(decideGate(withChampion({ championNow: null })).reason).toBe('champion_changed');
  });

  it('champion_changed is checked first', () => {
    expect(decideGate(withChampion({ championNow: 'run-b', scorecard: scorecardWith({ comparison: null }) })).reason).toBe('champion_changed');
    const worse = comparisonWith({ weeklyWape: 0.1 }, { weeklyWape: 0.3, coverage80: { inside: 0, weeks: 3 } }, 2);
    expect(decideGate(withChampion({ championNow: 'run-b', forecastsOn: false }, worse)).reason).toBe('champion_changed');
  });
});

describe('decideGate for a first draft', () => {
  it('a model draft publishes with 595+ days, 12 weeks with a range, coverage in band, 1 point under the weekday median', () => {
    expect(decideGate(first({}, { metrics: metricsWith({ weeklyWape: 0.19 }) }, { spanDays: 595 }))).toEqual({
      publish: true,
      reason: 'published',
    });
  });

  it('594 days or 11 weeks with a range is not_enough_history for a model draft', () => {
    expect(decideGate(first({}, {}, { spanDays: 594 })).reason).toBe('not_enough_history');
    expect(decideGate(first({}, { weeksWithRange: 11 })).reason).toBe('not_enough_history');
    // What 420 days gives under the lab's rules (modeling/lab pins them): at most 4 scored weeks, none with a range.
    expect(decideGate(first({}, { weeks: 4, weeksWithRange: 0 }, { spanDays: 420 })).reason).toBe('not_enough_history');
  });

  it('the lab’s own scorecard (its golden result, made by its origin and window rules) clears the history check', () => {
    const golden = labResultSchema.parse(JSON.parse(readFileSync(new URL('../../modeling/lab/tests/golden/result.json', import.meta.url), 'utf8')));
    if (!golden.ok) return expect.unreachable('the golden result is a success');
    const { history, backtest } = golden.scorecard;
    expect(history.spanDays).toBeGreaterThanOrEqual(GATE.minHistoryDays);
    expect(backtest.weeksWithRange).toBeGreaterThanOrEqual(GATE.heldOutWeeksMin);
    const input: GateInput = {
      forecastsOn: true, championAtStart: null, championNow: null, scorecard: { ...golden.scorecard, comparison: null }, current: null, jump: null,
    };
    expect(decideGate(input).reason).not.toBe('not_enough_history');
  });

  it('0.4 points under the median is baseline_not_beaten', () => {
    const input = first({}, { metrics: metricsWith({ weeklyWape: 0.196 }) });
    expect(decideGate(input)).toEqual({ publish: false, reason: 'baseline_not_beaten' });
  });

  it('coverage out of band and forecasts off', () => {
    const wide = first({}, { metrics: metricsWith({ weeklyWape: 0.19, coverage80: { inside: 12, weeks: 12 } }) });
    expect(decideGate(wide).reason).toBe('coverage_out_of_band');
    expect(decideGate(first({ forecastsOn: false })).reason).toBe('forecasts_off');
  });

  it('a champion that appeared meanwhile is champion_changed', () => {
    expect(decideGate(first({ championNow: 'run-b' })).reason).toBe('champion_changed');
  });
});

describe('decideGate for a baseline draft: its absolute checks (D42)', () => {
  const baseline = (backtest: Partial<LabScorecard['backtest']>, history: Partial<LabScorecard['history']> = { spanDays: 300 }) =>
    first({ scorecard: scorecardWith({ engine: 'baseline', comparison: null, backtest: { ...YOUNG, ...backtest }, history }) });

  it('a young restaurant’s first forecast: 300 days, 14 weeks, 11 inside, -2 points, 11% against 13% publishes', () => {
    expect(decideGate(baseline({}))).toEqual({ publish: true, reason: 'published' });
  });

  it('needs 12 weeks with a range (too_few_weeks), not the model’s 595 days', () => {
    expect(decideGate(baseline({ weeksWithRange: 11, metrics: metricsWith({ weeklyWape: 0.11, coverage80: { inside: 9, weeks: 11 } }) })).reason)
      .toBe('too_few_weeks');
    expect(decideGate(baseline({ weeksWithRange: 12, metrics: metricsWith({ weeklyWape: 0.11, coverage80: { inside: 10, weeks: 12 } }) })).publish)
      .toBe(true);
  });

  it('coverage 65% to 95%', () => {
    const at = (inside: number) => decideGate(baseline({ metrics: metricsWith({ weeklyWape: 0.11, coverage80: { inside, weeks: 14 } }) }));
    expect(at(9).reason).toBe('coverage_out_of_band'); // 64%
    expect(at(14).reason).toBe('coverage_out_of_band');
    expect(at(10).publish).toBe(true);
    expect(at(13).publish).toBe(true);
  });

  it('a bias past 5 points either way is biased; exactly 5 passes', () => {
    expect(decideGate(baseline({ weeklyBias: 0.07 }))).toEqual({ publish: false, reason: 'biased' });
    expect(decideGate(baseline({ weeklyBias: -0.0501 })).reason).toBe('biased');
    expect(decideGate(baseline({ weeklyBias: 0.05 })).publish).toBe(true);
    expect(decideGate(baseline({ weeklyBias: -0.05 })).publish).toBe(true);
  });

  it('a baseline no better than the weekday median is baseline_not_beaten: a tie fails, any gain passes', () => {
    const at = (weeklyWape: number) => decideGate(baseline({ metrics: metricsWith({ weeklyWape, coverage80: { inside: 11, weeks: 14 } }) }));
    expect(at(0.13)).toEqual({ publish: false, reason: 'baseline_not_beaten' });
    expect(at(0.1299).publish).toBe(true);
  });
});

describe('decideGate against a current lab run (D42, one set of rules for every calibration)', () => {
  it('an org admin’s model draft against a one-week-old model run publishes refreshed, not too_few_weeks', () => {
    // 8.9% against the streak's best 9.1%: no held-out week to compare, which used to answer too_few_weeks
    const input = refresh('model', labCurrent('model', 0.091), { metrics: metricsWith({ weeklyWape: 0.089 }) });
    expect(input.scorecard.comparison).toBeNull();
    expect(decideGate(input)).toEqual({ publish: true, reason: 'refreshed' });
  });

  it('new weeks are taken in: 9.4% against the streak’s best 9.1% publishes refreshed', () => {
    expect(decideGate(refresh('model', labCurrent('model', 0.091), { metrics: metricsWith({ weeklyWape: 0.094 }) })))
      .toEqual({ publish: true, reason: 'refreshed' });
  });

  it('a same-engine tie publishes: equal to the best, and exactly half a point above it', () => {
    const at = (weeklyWape: number) => decideGate(refresh('model', labCurrent('model', 0.091), { metrics: metricsWith({ weeklyWape }) }));
    expect(at(0.091)).toEqual({ publish: true, reason: 'refreshed' });
    expect(at(0.096)).toEqual({ publish: true, reason: 'refreshed' });
    expect(at(0.0961)).toEqual({ publish: false, reason: 'refresh_worse' });
  });

  it('no slow drift: refits of 9.1%, 9.5% and 9.6% hold a fourth at 9.7%', () => {
    // Each refit is judged against the best recorded in the streak so far
    const recorded: number[] = [0.091];
    const judge = (weeklyWape: number) => {
      const decision = decideGate(refresh('model', labCurrent('model', Math.min(...recorded)), { metrics: metricsWith({ weeklyWape }) }));
      if (decision.publish) recorded.push(weeklyWape);
      return decision;
    };
    expect(judge(0.095).reason).toBe('refreshed');
    expect(judge(0.096).reason).toBe('refreshed');
    expect(judge(0.097)).toEqual({ publish: false, reason: 'refresh_worse' });
    expect(recorded).toEqual([0.091, 0.095, 0.096]);
  });

  it('a same-engine baseline refit needs its absolute checks and the tolerance', () => {
    const current = labCurrent('baseline', 0.11);
    expect(decideGate(refresh('baseline', current, YOUNG))).toEqual({ publish: true, reason: 'refreshed' });
    expect(decideGate(refresh('baseline', current, { ...YOUNG, weeklyBias: 0.08 })).reason).toBe('biased');
    expect(decideGate(refresh('baseline', labCurrent('baseline', 0.1), YOUNG)).reason).toBe('refresh_worse');
  });

  it('a model refit keeps the model’s absolute checks: coverage, weekday bias against the current run’s recorded, the median', () => {
    const current = labCurrent('model', 0.191, 0.05);
    expect(decideGate(refresh('model', current)).publish).toBe(true);
    expect(decideGate(refresh('model', current, { metrics: metricsWith({ weeklyWape: 0.19, coverage80: { inside: 7, weeks: 12 } }) })).reason)
      .toBe('coverage_out_of_band');
    expect(decideGate(refresh('model', current, { weeksWithRange: 11, metrics: metricsWith({ weeklyWape: 0.19, coverage80: { inside: 9, weeks: 11 } }) })).reason)
      .toBe('too_few_weeks');
    expect(decideGate(refresh('model', current, { metrics: metricsWith({ weeklyWape: 0.19, weekdayBiasMeanAbs: 0.0701 }) })).reason)
      .toBe('weekday_bias_worse');
    expect(decideGate(refresh('model', current, { metrics: metricsWith({ weeklyWape: 0.19, weekdayBiasMeanAbs: 0.07 }) })).publish).toBe(true);
    expect(decideGate(refresh('model', current, { weekdayMedianWeeklyWape: 0.194 })).reason).toBe('baseline_not_beaten');
  });

  it('an engine switch: a model draft against a baseline run publishes on the model’s absolute checks alone', () => {
    // The lab chose it 0.6 points better than the baseline on the same weeks; the baseline run's recorded 9.0% is not
    // compared again, so a model backtest of 19% (from other weeks) still publishes
    const engines = { model: { weeks: 12, weeklyWape: 0.19, weeklyBias: 0, coverage80: { inside: 10, weeks: 12 } },
      baseline: { weeks: 12, weeklyWape: 0.196, weeklyBias: 0, coverage80: { inside: 10, weeks: 12 } } };
    const input = refresh('model', labCurrent('baseline', 0.09), {}, {}, engines);
    expect(decideGate(input)).toEqual({ publish: true, reason: 'engine_switched' });
    expect(decideGate({ ...input, scorecard: { ...input.scorecard, backtest: { ...input.scorecard.backtest, weekdayMedianWeeklyWape: 0.19 } } }).reason)
      .toBe('baseline_not_beaten');
  });

  it('a baseline draft made because the model could not run, against a model run, is model_not_run', () => {
    const notRun = { model: null, baseline: { weeks: 14, weeklyWape: 0.11, weeklyBias: -0.02, coverage80: { inside: 11, weeks: 14 } } };
    const input = refresh('baseline', labCurrent('model', 0.09), YOUNG, {}, notRun);
    expect(decideGate(input)).toEqual({ publish: false, reason: 'model_not_run' });
    // Against an imported model run too
    expect(decideGate({ ...input, current: IMPORTED, scorecard: { ...input.scorecard, comparison: comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.1 }) } }).reason)
      .toBe('model_not_run');
    // When the model ran and lost by 0.5 points or more, it is an engine switch
    const lost = { ...notRun, model: { weeks: 14, weeklyWape: 0.12, weeklyBias: 0, coverage80: { inside: 11, weeks: 14 } } };
    expect(decideGate(refresh('baseline', labCurrent('model', 0.09), YOUNG, {}, lost))).toEqual({ publish: true, reason: 'engine_switched' });
  });

  it('a lab run whose scorecard is gone is judged as an imported one, on held-out weeks', () => {
    const input = refresh('model', { engine: 'model', recorded: null, streakBest: null }, {}, {});
    expect(decideGate(input).reason).toBe('too_few_weeks');
  });
});

describe('the jump guard (D42)', () => {
  const passing = (jump: GateInput['jump'], over: Partial<GateInput> = {}) =>
    decideGate(refresh('model', labCurrent('model', 0.091), { metrics: metricsWith({ weeklyWape: 0.09 }) }, { jump, ...over }));

  it('5,200 against 4,000 is held; 4,300 against 4,000 is not', () => {
    expect(passing({ draft: 5200, current: 4000 })).toEqual({ publish: false, reason: 'jump_held' });
    expect(passing({ draft: 4300, current: 4000 })).toEqual({ publish: true, reason: 'refreshed' });
  });

  it('either way, and exactly 25% is not held', () => {
    expect(passing({ draft: 2999, current: 4000 }).reason).toBe('jump_held');
    expect(passing({ draft: 3000, current: 4000 }).publish).toBe(true);
    expect(passing({ draft: 5000, current: 4000 }).publish).toBe(true);
  });

  it('applies only to a draft that passed every other check, before forecasts_off, and against an imported run too', () => {
    const worse = refresh('model', labCurrent('model', 0.05), {}, { jump: { draft: 9000, current: 4000 } });
    expect(decideGate(worse).reason).toBe('refresh_worse');
    expect(passing({ draft: 9000, current: 4000 }, { forecastsOn: false }).reason).toBe('jump_held');
    expect(decideGate(withChampion({ jump: { draft: 9000, current: 4000 } })).reason).toBe('jump_held');
  });

  it('no days both forecast open is no jump', () => {
    expect(passing({ draft: 0, current: 0 }).publish).toBe(true);
    expect(passing(null).publish).toBe(true);
  });
});

describe('jumpSums', () => {
  const row = (from: string, status: 'open' | 'closed' | 'booked', mid: number | null): ForecastRow =>
    ({ span: 'day', from, to: from, status, mid }) as unknown as ForecastRow;

  it('sums both runs’ middles over the 28 days from today, on the days both forecast open', () => {
    const today = '2026-11-23';
    const draft = [
      { date: '2026-11-22', status: 'open' as const, mid: 1000 }, // before today
      { date: '2026-11-23', status: 'open' as const, mid: 150 },
      { date: '2026-11-24', status: 'open' as const, mid: 160 },
      { date: '2026-11-25', status: 'closed' as const, mid: null }, // closed in the draft
      { date: '2026-11-26', status: 'open' as const, mid: 170 }, // closed in the current run
      { date: '2026-11-27', status: 'open' as const, mid: 180 }, // not in the current run
      { date: '2026-12-20', status: 'open' as const, mid: 190 }, // the 28th day
      { date: '2026-12-21', status: 'open' as const, mid: 1000 }, // the 29th
    ];
    const current = [
      row('2026-11-22', 'open', 900), row('2026-11-23', 'open', 100), row('2026-11-24', 'open', 110), row('2026-11-25', 'open', 120),
      row('2026-11-26', 'closed', null), row('2026-12-20', 'open', 130), row('2026-12-21', 'open', 900),
      { ...row('2026-11-23', 'open', 700), span: 'week', to: '2026-11-29' } as ForecastRow,
    ];
    expect(jumpSums(draft, current, today)).toEqual({ draft: 150 + 160 + 190, current: 100 + 110 + 130 });
  });
});

describe('streakOf', () => {
  const run = (id: string, family: string, lab: boolean) =>
    ({ id, model: { family }, lab: lab ? { calibrationId: `cal-${id}` } : null }) as unknown as ForecastRunRecord;

  it('is the consecutive published lab runs of the current run’s engine, from it back to one of another engine or imported', () => {
    const published = [
      run('newest', 'hybrid_linear_xgboost', true), run('a', 'hybrid_linear_xgboost', true), run('b', 'hybrid_linear_xgboost', true),
      run('switch', 'seasonal_baseline', true), run('older', 'hybrid_linear_xgboost', true),
    ];
    expect(streakOf(published, 'a').map((each) => each.id)).toEqual(['a', 'b']);
    expect(streakOf(published, 'switch').map((each) => each.id)).toEqual(['switch']);
    const imported = [run('x', 'seasonal_baseline', true), run('import', 'seasonal_baseline', false), run('y', 'seasonal_baseline', true)];
    expect(streakOf(imported, 'x').map((each) => each.id)).toEqual(['x']);
    expect(streakOf(imported, 'import')).toEqual([]);
    expect(streakOf(imported, 'gone')).toEqual([]);
  });
});

describe('currentChampion', () => {
  const run = (id: string, dataThrough: string, to: string, status = 'published') =>
    ({ id, status, dataThrough, range: { from: dataThrough, to } }) as unknown as ForecastRunRecord;

  it('skips a run ending before today + 28 and picks the newest dataThrough of the rest; null with none', () => {
    const today = '2026-06-01';
    const old = run('old', '2026-01-01', '2026-07-01');
    const newer = run('newer', '2026-03-01', '2026-07-01');
    const short = run('short', '2026-05-01', '2026-06-28');
    expect(currentChampion([old, newer, short], today)?.id).toBe('newer');
    expect(currentChampion([run('edge', '2026-05-01', '2026-06-29')], today)?.id).toBe('edge');
    expect(currentChampion([short], today)).toBeNull();
    expect(currentChampion([], today)).toBeNull();
  });

  it('skips a run that is not published, and keeps the first of two with the same dataThrough', () => {
    const today = '2026-06-01';
    expect(currentChampion([run('draft', '2026-05-01', '2026-07-01', 'draft'), run('kept', '2026-03-01', '2026-07-01')], today)?.id).toBe('kept');
    expect(currentChampion([run('newer-publish', '2026-03-01', '2026-07-01'), run('older-publish', '2026-03-01', '2026-07-01')], today)?.id)
      .toBe('newer-publish');
  });
});

describe('GATE_WORDS', () => {
  it('has words for every reason, with no em dashes or straight apostrophes', () => {
    for (const reason of GATE_REASONS) {
      expect(GATE_WORDS[reason]).toBeTruthy();
      expect(GATE_WORDS[reason]).not.toMatch(/[—']/);
    }
    expect(GATE_REASONS).toEqual(expect.arrayContaining(['refreshed', 'refresh_worse', 'model_not_run', 'biased', 'jump_held', 'engine_switched']));
  });

  it('says what a published draft beat: the weekday average for a first forecast, the current forecast otherwise', () => {
    expect(gateWords('published', true)).toBe('Better than the weekday average on its backtest weeks, so Townwise published it.');
    expect(gateWords('published', false)).toBe(GATE_WORDS.published);
    expect(GATE_WORDS.published).toContain('current forecast');
    expect(gateWords('not_better', true)).toBe(GATE_WORDS.not_better);
    expect(gateWords('forecasts_off', false)).toBe(GATE_WORDS.forecasts_off);
    expect(gateWords('refreshed', true)).toBe(GATE_WORDS.refreshed);
  });

  it('an engine switch says which engine Townwise switched to and by how many points on the same weeks', () => {
    const engines = { model: { weeks: 12, weeklyWape: 0.19, weeklyBias: 0, coverage80: { inside: 10, weeks: 12 } },
      baseline: { weeks: 12, weeklyWape: 0.196, weeklyBias: 0, coverage80: { inside: 10, weeks: 12 } } };
    const switched = engineSwitchOf({ engine: 'model', engines });
    expect(switched).toEqual({ engine: 'model', points: 0.6 });
    expect(gateWords('engine_switched', false, switched))
      .toBe('Townwise switched to its demand model: it was 0.6 points better on the same held-out weeks, so Townwise published it.');
    const toBaseline = engineSwitchOf({ engine: 'baseline', engines: { ...engines, model: { ...engines.model, weeklyWape: 0.2042 } } });
    expect(gateWords('engine_switched', false, toBaseline)).toBe(
      'Townwise switched to its baseline from your recent weeks and the town calendar: it was 0.8 points better on the same held-out weeks, so Townwise published it.',
    );
    // Without both engines' figures (a scorecard from before D42, or the model not run) the words don't name a margin
    expect(engineSwitchOf({ engine: 'baseline', engines: { ...engines, model: null } })).toBeNull();
    expect(engineSwitchOf({})).toBeNull();
    expect(gateWords('engine_switched', false, null)).toBe(GATE_WORDS.engine_switched);
    expect(GATE_WORDS.engine_switched).toContain('half a point');
    // Another reason's words never change with the switch
    expect(gateWords('refreshed', false, switched)).toBe(GATE_WORDS.refreshed);
  });

  it('states the gate’s own values, so a changed value changes its words too', () => {
    const weeks = `${String(GATE.heldOutWeeksMin)} weeks`;
    expect(GATE_WORDS.too_few_weeks).toContain(weeks);
    expect(GATE_WORDS.not_enough_history).toContain(`${String(GATE.heldOutWeeksMin)} held-out weeks`);
    expect(GATE_WORDS.coverage_out_of_band).toContain(`between ${String(GATE.coverageMin * 100)}% and ${String(GATE.coverageMax * 100)}%`);
    expect(GATE.wapeMargin).toBe(0.005);
    expect(GATE_WORDS.not_better).toContain('half a point');
    expect(GATE_WORDS.refreshed).toContain('half a point');
    expect(GATE_WORDS.refresh_worse).toContain('half a point');
    expect(GATE_WORDS.biased).toContain(`${String(GATE.baselineBiasMax * 100)} points`);
    expect(GATE_WORDS.jump_held).toContain(`${String(GATE.jumpDays)} days`);
    expect(GATE_WORDS.jump_held).toContain(`${String(GATE.jumpMax * 100)}%`);
    expect(START_REFUSAL_WORDS.not_enough_history).toContain(`${String(GATE.minHistoryDays)} days`);
  });

  it('the lab’s own history minimums are the gate’s', () => {
    const pipeline = readFileSync(new URL('../../modeling/lab/townwise_lab/pipeline.py', import.meta.url), 'utf8');
    expect(/^MIN_HISTORY_DAYS = (\d+)/m.exec(pipeline)?.[1]).toBe(String(GATE.minHistoryDays));
    const baseline = readFileSync(new URL('../../modeling/lab/townwise_lab/baseline.py', import.meta.url), 'utf8');
    expect(/^MIN_HISTORY_DAYS = (\d+)/m.exec(baseline)?.[1]).toBe(String(GATE.baselineMinHistoryDays));
  });
});
