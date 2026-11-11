import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { comparisonWith, metricsWith, scorecardWith } from './helpers/lab-scorecard.ts';
import { currentChampion, decideGate, GATE, GATE_REASONS, GATE_WORDS, gateWords, type GateInput } from '../src/lab/gate.ts';
import { labResultSchema } from '../src/lab/result.ts';
import type { Scorecard } from '../src/lab/scorecard.ts';
import { START_REFUSAL_WORDS } from '../src/lab/service.ts';
import type { ForecastRunRecord } from '../src/stores/forecasts.ts';

function withChampion(over: Partial<GateInput> = {}, comparison = comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.19 })): GateInput {
  return {
    forecastsOn: true,
    championAtStart: 'run-a',
    championNow: 'run-a',
    scorecard: scorecardWith({ comparison }),
    ...over,
  };
}

function first(
  over: Partial<GateInput> = {}, backtest: Partial<Scorecard['backtest']> = {}, history: Partial<Scorecard['history']> = {},
): GateInput {
  return {
    forecastsOn: true,
    championAtStart: null,
    championNow: null,
    scorecard: scorecardWith({ comparison: null, backtest, history }),
    ...over,
  };
}

describe('decideGate with a current forecast', () => {
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
  it('publishes with 595+ days, 12 weeks with a range, coverage in band, 1 point under the weekday median', () => {
    expect(decideGate(first({}, { metrics: metricsWith({ weeklyWape: 0.19 }) }, { spanDays: 595 }))).toEqual({
      publish: true,
      reason: 'published',
    });
  });

  it('594 days or 11 weeks with a range is not_enough_history', () => {
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
    const input: GateInput = { forecastsOn: true, championAtStart: null, championNow: null, scorecard: { ...golden.scorecard, comparison: null } };
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
  });

  it('says what a published draft beat: the weekday average for a first forecast, the current forecast otherwise', () => {
    expect(gateWords('published', true)).toBe('Better than the weekday average on its backtest weeks, so Townwise published it.');
    expect(gateWords('published', false)).toBe(GATE_WORDS.published);
    expect(GATE_WORDS.published).toContain('current forecast');
    expect(gateWords('not_better', true)).toBe(GATE_WORDS.not_better);
    expect(gateWords('forecasts_off', false)).toBe(GATE_WORDS.forecasts_off);
  });

  it('states the gate’s own values, so a changed value changes its words too', () => {
    const weeks = `${String(GATE.heldOutWeeksMin)} weeks`;
    expect(GATE_WORDS.too_few_weeks).toContain(weeks);
    expect(GATE_WORDS.not_enough_history).toContain(`${String(GATE.heldOutWeeksMin)} held-out weeks`);
    expect(GATE_WORDS.coverage_out_of_band).toContain(`between ${String(GATE.coverageMin * 100)}% and ${String(GATE.coverageMax * 100)}%`);
    expect(GATE.wapeMargin).toBe(0.005);
    expect(GATE_WORDS.not_better).toContain('half a point');
    expect(START_REFUSAL_WORDS.not_enough_history).toContain(`${String(GATE.minHistoryDays)} days`);
  });

  it('the lab’s own history minimum is the gate’s', () => {
    const pipeline = readFileSync(new URL('../../modeling/lab/townwise_lab/pipeline.py', import.meta.url), 'utf8');
    expect(/^MIN_HISTORY_DAYS = (\d+)/m.exec(pipeline)?.[1]).toBe(String(GATE.minHistoryDays));
  });
});
