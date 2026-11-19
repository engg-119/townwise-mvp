// Suggested closure rules (openspec change suggest-closure-rules, D46), without Docker: the closure key a suggestion is
// deduped on, the words Townwise writes for it from its schedule, and when a location's rules already make one
// pointless; and (D59 slice 3) when the sales history is sure of a closed weekday. Every date is synthetic.
import { describe, expect, it } from 'vitest';

import { closureKeyOf, closureRuleText, isSuggestable, salesEvidenceSure } from '../src/agent/closure-suggestions.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';

const MONDAYS: RuleSchedule = {
  kind: 'closure', startDate: '2026-11-17', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
};
const WINTER: RuleSchedule = { ...MONDAYS, weekdays: null, startDate: '2027-01-04', endDate: '2027-03-31' };
const YEARLY: RuleSchedule = { ...MONDAYS, weekdays: null, season: { repeat: 'yearly', from: '01-01', to: '03-31' } };

describe('closureKeyOf', () => {
  it('is the weekdays (sorted, or *), then the dates of a range, the season of a yearly rule, or ongoing', () => {
    expect(closureKeyOf(MONDAYS)).toBe('closed|w=1|ongoing');
    expect(closureKeyOf({ ...MONDAYS, weekdays: [2, 1] })).toBe('closed|w=1,2|ongoing');
    expect(closureKeyOf(WINTER)).toBe('closed|w=*|2027-01-04..2027-03-31');
    expect(closureKeyOf(YEARLY)).toBe('closed|w=*|yearly=01-01..03-31');
    expect(closureKeyOf({ ...YEARLY, weekdays: [1] })).toBe('closed|w=1|yearly=01-01..03-31');
  });

  it('ignores the start of a standing or yearly rule, so two sources of one rule share a key', () => {
    expect(closureKeyOf({ ...MONDAYS, startDate: '2026-09-08' })).toBe(closureKeyOf(MONDAYS));
    expect(closureKeyOf({ ...YEARLY, startDate: '2027-05-01' })).toBe(closureKeyOf(YEARLY));
  });
});

describe('closureRuleText', () => {
  it('words the six forms from the schedule alone', () => {
    expect([
      MONDAYS,
      { ...MONDAYS, weekdays: [2, 1] },
      WINTER,
      { ...WINTER, weekdays: [1] },
      YEARLY,
      { ...YEARLY, weekdays: [1] },
    ].map(closureRuleText)).toEqual([
      'Closed on Mondays',
      'Closed on Mondays and Tuesdays',
      'Closed Jan 4 to Mar 31, 2027',
      'Closed on Mondays, Jan 4 to Mar 31, 2027',
      'Closed Jan 1 to Mar 31 every year',
      'Closed on Mondays, Jan 1 to Mar 31 every year',
    ]);
  });

  it('names both years of a range across the new year, and a season across it plainly', () => {
    expect(closureRuleText({ ...WINTER, startDate: '2026-12-20', endDate: '2027-01-05' })).toBe('Closed Dec 20, 2026 to Jan 5, 2027');
    expect(closureRuleText({ ...YEARLY, season: { repeat: 'yearly', from: '12-20', to: '01-05' } })).toBe('Closed Dec 20 to Jan 5 every year');
  });
});

describe('isSuggestable', () => {
  const rule = (text: string, schedule: RuleSchedule | null) => ({ text, schedule });

  it('with no rules, always', () => {
    for (const schedule of [MONDAYS, WINTER, YEARLY]) expect(isSuggestable(schedule, { rules: [] })).toBe(true);
  });

  it('not when an ongoing closure rule already closes the same weekdays or more', () => {
    expect(isSuggestable(MONDAYS, { rules: [rule('Shut Mondays', { ...MONDAYS, startDate: '2025-01-06' })] })).toBe(false);
    expect(isSuggestable(MONDAYS, { rules: [rule('Shut Mon and Tue', { ...MONDAYS, weekdays: [1, 2] })] })).toBe(false);
    expect(isSuggestable(MONDAYS, { rules: [rule('Closed for good', { ...MONDAYS, weekdays: null })] })).toBe(false);
    // A rule on other weekdays, one with an end, a season, or more guests leaves it.
    expect(isSuggestable(MONDAYS, { rules: [rule('Shut Tuesdays', { ...MONDAYS, weekdays: [2] })] })).toBe(true);
    expect(isSuggestable(MONDAYS, { rules: [rule('Shut Mondays this winter', { ...MONDAYS, endDate: '2027-03-31' })] })).toBe(true);
    expect(isSuggestable(MONDAYS, { rules: [rule('Shut Mondays in winter', { ...YEARLY, weekdays: [1] })] })).toBe(true);
    expect(isSuggestable(MONDAYS, { rules: [rule('Busy Mondays', { ...MONDAYS, kind: 'other', effect: 'more_guests' })] })).toBe(true);
    // Every day of the week, ongoing, is not covered by a rule on some of them.
    expect(isSuggestable({ ...MONDAYS, weekdays: null }, { rules: [rule('Shut Mondays', MONDAYS)] })).toBe(true);
  });

  it('a dated range or a season only by a closure rule with the same key', () => {
    expect(isSuggestable(WINTER, { rules: [rule('Winter break', { ...WINTER, startDate: '2027-01-04' })] })).toBe(false);
    expect(isSuggestable(WINTER, { rules: [rule('Winter break', { ...WINTER, endDate: '2027-03-30' })] })).toBe(true);
    expect(isSuggestable(YEARLY, { rules: [rule('Winters', { ...YEARLY, startDate: '2026-01-01' })] })).toBe(false);
  });

  it('not when a rule with a schedule has its words in any case; a rule with the words and no schedule does not block it', () => {
    expect(isSuggestable(MONDAYS, { rules: [rule('closed on mondays', { ...WINTER })] })).toBe(false);
    expect(isSuggestable(MONDAYS, { rules: [rule('Closed on Mondays', null)] })).toBe(true);
  });
});

describe('salesEvidenceSure (D59 slice 3)', () => {
  it('is sure only with at least 8 counted days, at least 90% of them with no sales', () => {
    expect(salesEvidenceSure({ noSalesCount: 8, weekdayCount: 8 })).toBe(true);
    expect(salesEvidenceSure({ noSalesCount: 9, weekdayCount: 10 })).toBe(true);
    expect(salesEvidenceSure({ noSalesCount: 7, weekdayCount: 7 })).toBe(false);
    expect(salesEvidenceSure({ noSalesCount: 17, weekdayCount: 20 })).toBe(false);
  });
});
