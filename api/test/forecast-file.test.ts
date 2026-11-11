// The forecast run file (spec 14.4), without Docker: the strict shape at every level, the rules across fields, issues
// that carry a path and a code and never a value, the canonical hash, and labels that come from code and the public
// calendar, never from the file. The fixture's numbers are synthetic.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalSha256, checkForecastRunFile, checkLabRunFile, runFileSha256, type ForecastRunFile } from '../src/forecasts/file.ts';
import { reasonViews, storedRef, townCalendarOf } from '../src/forecasts/reasons.ts';
import { townEvents } from '../src/town-calendar.ts';

const TODAY = '2026-06-01';
const FIXTURE = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as ForecastRunFile;
/** A value that must never appear in an issue list. */
const SENTINEL = 'sentinel-guest-name';

function file(edit: (copy: Record<string, unknown> & ForecastRunFile) => void = () => undefined): unknown {
  const copy = structuredClone(FIXTURE) as Record<string, unknown> & ForecastRunFile;
  edit(copy);
  return copy;
}

function issuesOf(raw: unknown): { path: string; code: string }[] {
  const check = checkForecastRunFile(raw, TODAY);
  return check.ok ? [] : check.issues;
}

function day(copy: ForecastRunFile, date: string): ForecastRunFile['days'][number] {
  const found = copy.days.find((each) => each.date === date);
  if (found === undefined) throw new Error(`no ${date}`);
  return found;
}

describe('the run file', () => {
  it('accepts the synthetic fixture', () => {
    const check = checkForecastRunFile(FIXTURE, TODAY);
    expect(check.ok).toBe(true);
  });

  it('rejects an unknown key at every level, naming the path but never the key', () => {
    for (const [edit, path] of [
      [(copy: Record<string, unknown>) => { copy[SENTINEL] = 1; }, ''],
      [(copy: ForecastRunFile) => { (copy.model as Record<string, unknown>)[SENTINEL] = 1; }, 'model'],
      [(copy: ForecastRunFile) => { (day(copy, '2026-05-02') as Record<string, unknown>)[SENTINEL] = 1; }, 'days[1]'],
      [(copy: ForecastRunFile) => { (copy.days[1]?.reasons[0] as Record<string, unknown>).label = SENTINEL; }, 'days[1].reasons[0]'],
      [(copy: ForecastRunFile) => { (copy.weeks[0] as Record<string, unknown>)[SENTINEL] = 1; }, 'weeks[0]'],
    ] as const) {
      const issues = issuesOf(file(edit));
      expect(issues).toEqual([{ path, code: 'unrecognized_keys' }]);
      expect(JSON.stringify(issues)).not.toContain(SENTINEL);
    }
  });

  it('takes no free text: a location id, a name or a note is an unknown key', () => {
    for (const key of ['locationId', 'name', 'note', 'url']) {
      expect(issuesOf(file((copy) => { copy[key] = SENTINEL; }))).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    }
  });

  it('accepts only exports an owner sent Townwise (training on uploaded days waits for the team’s decision)', () => {
    expect(issuesOf(file((copy) => { (copy as Record<string, unknown>).trainingSource = 'townwise_uploads'; }))).toEqual([
      { path: 'trainingSource', code: 'invalid_value' },
    ]);
  });

  it('a lab run file passes checkLabRunFile and the import schema still refuses trainingSource townwise_lab', () => {
    const lab = file((copy) => { (copy as Record<string, unknown>).trainingSource = 'townwise_lab'; });
    expect(checkLabRunFile(lab, TODAY).ok).toBe(true);
    expect(issuesOf(lab)).toEqual([{ path: 'trainingSource', code: 'invalid_value' }]);
    // The lab file takes no other source, and no frozen registration.
    expect(checkLabRunFile(FIXTURE, TODAY)).toEqual({ ok: false, issues: [{ path: 'trainingSource', code: 'invalid_value' }] });
    const frozen = file((copy) => {
      (copy as Record<string, unknown>).trainingSource = 'townwise_lab';
      (copy as Record<string, unknown>).frozen = { files: [{ name: 'frozen_forecast_x.csv', sha256: 'a'.repeat(64) }] };
    });
    expect(checkLabRunFile(frozen, TODAY)).toEqual({ ok: false, issues: [{ path: 'frozen', code: 'invalid_type' }] });
    // The same cross-field rules apply.
    const late = file((copy) => { (copy as Record<string, unknown>).trainingSource = 'townwise_lab'; copy.madeAt = '2026-06-02'; });
    expect(checkLabRunFile(late, TODAY)).toEqual({ ok: false, issues: [{ path: 'madeAt', code: 'made_in_future' }] });
    expect(runFileSha256(FIXTURE)).toBe(canonicalSha256(FIXTURE));
  });

  it('needs low <= mid <= high on open days, and words the issue on the field that is out of order', () => {
    expect(issuesOf(file((copy) => { day(copy, '2026-05-02').high = 90; }))).toEqual([{ path: 'days[1].high', code: 'below_mid' }]);
    expect(issuesOf(file((copy) => { day(copy, '2026-05-02').mid = 70; }))).toEqual([{ path: 'days[1].mid', code: 'below_low' }]);
    expect(issuesOf(file((copy) => { day(copy, '2026-05-02').low = null; }))).toEqual([{ path: 'days[1]', code: 'numbers_required' }]);
    expect(issuesOf(file((copy) => { day(copy, '2026-05-02').high = 20_001; }))).toEqual([{ path: 'days[1].high', code: 'too_big' }]);
    expect(issuesOf(file((copy) => { day(copy, '2026-05-02').low = -1; }))).toEqual([{ path: 'days[1].low', code: 'too_small' }]);
  });

  it('gives closed and booked days no numbers', () => {
    expect(issuesOf(file((copy) => { day(copy, '2026-05-04').mid = 100; }))).toEqual([{ path: 'days[3]', code: 'numbers_not_allowed' }]);
    expect(issuesOf(file((copy) => { day(copy, '2026-05-13').baseline = 100; }))).toEqual([{ path: 'days[12]', code: 'numbers_not_allowed' }]);
  });

  it('forecasts only days after the model’s data, once each, within 400 days', () => {
    expect(issuesOf(file((copy) => { day(copy, '2026-05-01').date = '2026-04-30'; }))).toEqual(expect.arrayContaining([
      { path: 'days[0].date', code: 'not_after_data' },
    ]));
    expect(issuesOf(file((copy) => { day(copy, '2026-05-01').date = '2026-05-02'; }))).toEqual(expect.arrayContaining([
      { path: 'days[1].date', code: 'duplicate_date' },
    ]));
    expect(issuesOf(file((copy) => { day(copy, '2026-05-01').date = '2027-06-05'; }))).toEqual(expect.arrayContaining([
      { path: 'days[0].date', code: 'too_far_ahead' },
    ]));
    expect(issuesOf(file((copy) => { day(copy, '2026-05-01').date = '2026-02-30'; }))).toEqual([{ path: 'days[0].date', code: 'not_a_date' }]);
  });

  it('orders the run’s dates, and refuses a run made after today', () => {
    expect(issuesOf(file((copy) => { copy.trainedFrom = '2026-05-01'; }))).toEqual([{ path: 'trainedFrom', code: 'dates_out_of_order' }]);
    expect(issuesOf(file((copy) => { copy.madeAt = '2026-04-29'; }))).toEqual([{ path: 'dataThrough', code: 'dates_out_of_order' }]);
    expect(issuesOf(file((copy) => { copy.madeAt = '2026-06-02'; }))).toEqual([{ path: 'madeAt', code: 'made_in_future' }]);
    expect(issuesOf(file((copy) => { if (copy.backtest !== null) copy.backtest.weeksOver20Pct = 11; }))).toEqual([
      { path: 'backtest.weeksOver20Pct', code: 'over_count' },
    ]);
  });

  it('keeps weeks inside one Monday-to-Sunday week, on days the file has, without overlap, with matching open days', () => {
    expect(issuesOf(file((copy) => { if (copy.weeks[1] !== undefined) copy.weeks[1].to = '2026-05-11'; }))).toEqual(expect.arrayContaining([
      { path: 'weeks[1]', code: 'week_span' },
    ]));
    expect(issuesOf(file((copy) => { if (copy.weeks[2] !== undefined) copy.weeks[2].to = '2026-05-15'; }))).toEqual([
      { path: 'weeks[2]', code: 'week_day_missing' },
    ]);
    expect(issuesOf(file((copy) => { if (copy.weeks[1] !== undefined) copy.weeks[1].openDays = 7; }))).toEqual([
      { path: 'weeks[1].openDays', code: 'open_days_mismatch' },
    ]);
    // A booked day may count as open in the model's own week, or not.
    expect(issuesOf(file((copy) => { if (copy.weeks[2] !== undefined) copy.weeks[2].openDays = 2; }))).toEqual([]);
    expect(issuesOf(file((copy) => {
      copy.weeks.push({ from: '2026-05-10', to: '2026-05-10', openDays: 1, low: 80, mid: 100, high: 120 });
    }))).toEqual([{ path: 'weeks[3]', code: 'week_overlap' }]);
  });

  it('lets only term, event and holiday reasons name a calendar entry', () => {
    expect(issuesOf(file((copy) => { const first = day(copy, '2026-05-02').reasons[0]; if (first !== undefined) first.ref = 'hanover-nh:x'; }))).toEqual([
      { path: 'days[1].reasons[0].ref', code: 'ref_not_allowed' },
    ]);
  });

  it('lists at most 50 issues, each a path and a code only', () => {
    const issues = issuesOf(file((copy) => { for (const each of copy.days) each.date = '2026-04-01'; }));
    expect(issues.length).toBeLessThanOrEqual(50);
    for (const issue of issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
  });

  it('hashes the same run the same way whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(FIXTURE).reverse()) as ForecastRunFile;
    expect(runFileSha256(reordered)).toBe(runFileSha256(FIXTURE));
    expect(runFileSha256(file((copy) => { copy.madeAt = '2026-05-02'; }) as ForecastRunFile)).not.toBe(runFileSha256(FIXTURE));
  });
});

describe('labels come from code and the public calendar, never the file', () => {
  const hanover = townCalendarOf('hanover-nh');

  it('names the weekday, the term from the calendar, a holiday by its law, and plain words otherwise', () => {
    const views = reasonViews('2026-05-02', [
      { kind: 'weekday', ref: null, effectPct: null },
      { kind: 'term', ref: 'hanover-nh:classes:spring', effectPct: 5 },
      { kind: 'level', ref: null, effectPct: null },
      { kind: 'closure', ref: null, effectPct: null },
      { kind: 'booking', ref: null, effectPct: null },
      { kind: 'event', ref: null, effectPct: null },
    ], hanover('2026-05-02'));
    expect(views.map((view) => view.label)).toEqual([
      'Saturday', 'Spring term classes', 'Your recent level', 'Closed', 'Private event booked', 'Town event',
    ]);
    expect(views[1]?.effectPct).toBe(5);
    expect(views[1]?.sources.length).toBeGreaterThan(0);
    const thanksgiving = reasonViews('2026-11-26', [{ kind: 'holiday', ref: null, effectPct: null }], hanover('2026-11-26'));
    expect(thanksgiving).toEqual([{
      kind: 'holiday', label: 'Thanksgiving Day', effectPct: null,
      sources: [{ label: 'U.S. Office of Personnel Management', url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/' }],
    }]);
    // Halloween is no federal holiday and no calendar entry.
    expect(reasonViews('2026-10-31', [{ kind: 'holiday', ref: null, effectPct: null }], hanover('2026-10-31'))[0]?.label).toBe('Holiday');
  });

  it('names an event by its calendar id or group; a ref that names nothing reads plainly and is never stored', () => {
    expect(reasonViews('2026-11-21', [{ kind: 'event', ref: 'hanover-nh:home-football', effectPct: null }], hanover('2026-11-21'))[0]?.label)
      .toBe('Home football vs Brown');
    const unresolved = reasonViews('2026-11-21', [{ kind: 'event', ref: `hanover-nh:${SENTINEL}`, effectPct: null }], hanover('2026-11-21'));
    expect(unresolved).toEqual([{ kind: 'event', label: 'Town event', effectPct: null, sources: [] }]);
    expect(JSON.stringify(unresolved)).not.toContain(SENTINEL);
    const events = townEvents('hanover-nh', { from: '2026-11-21', to: '2026-11-21' });
    expect(storedRef(`hanover-nh:${SENTINEL}`, events)).toBeNull();
    expect(storedRef('hanover-nh:home-football', events)).toBe('hanover-nh:home-football');
  });

  it('a town outside the twelve has holidays only, so its term and events read plainly', () => {
    const outside = townCalendarOf(null);
    expect(reasonViews('2026-05-02', [{ kind: 'term', ref: 'hanover-nh:classes:spring', effectPct: null }], outside('2026-05-02'))[0]?.label)
      .toBe('Term');
  });
});
