import { ApiError } from '../../../src/api/client';
import type { RuleSuggestion } from '../../../src/portal/rules/api';
import { decideErrorLine, originOf, SUGGESTED_COPY, toDecideLine } from '../../../src/portal/rules/suggestionWords';

// A suggested closure rule in words (D46, P29 and P25): where it came from, and why a decision was refused. The rule's
// words and what it does are the API's (`text`, `scheduleSummary`), never a second copy here.

const FILE: RuleSuggestion = {
  id: 'd1', source: 'file', text: 'Closed on Tuesdays',
  schedule: { kind: 'closure', startDate: '2026-06-01', endDate: null, weekdays: [2], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
  scheduleSummary: 'Closed on Tuesdays from Jun 1, 2026', file: { ref: 'f_1', title: 'Hours.pdf' }, evidence: null, canDecide: true,
};
const SALES: RuleSuggestion = {
  ...FILE, id: 'sales_weekday_1', source: 'sales', text: 'Closed on Mondays', file: null,
  schedule: { ...FILE.schedule, weekdays: [1] }, evidence: { noSalesCount: 13, weekdayCount: 16, lastSalesDate: '2026-09-07' },
};

test('a file suggestion names its file, or says it is hidden or gone', () => {
  expect(originOf(FILE)).toEqual({ text: 'From Hours.pdf', ref: 'f_1' });
  expect(originOf({ ...FILE, file: { ref: 'f_1', title: null } })).toEqual({ text: 'From a file TownwiseAI read', ref: 'f_1' });
  expect(originOf({ ...FILE, file: null })).toEqual({ text: 'From a file you deleted', ref: null });
});

test('a sales suggestion gives its last day with sales, then its counts', () => {
  expect(originOf(SALES)).toEqual({ text: 'No sales on any Monday since Sep 7, 2026. In all, 13 of 16 Mondays had no sales.', ref: null });
  expect(originOf({ ...SALES, evidence: { noSalesCount: 13, weekdayCount: 13, lastSalesDate: null } }))
    .toEqual({ text: 'In your sales history, 13 of 13 Mondays had no sales.', ref: null });
  expect(originOf({ ...SALES, schedule: { ...SALES.schedule, weekdays: [0] }, evidence: { noSalesCount: 1, weekdayCount: 4, lastSalesDate: null } }))
    .toEqual({ text: 'In your sales history, 1 of 4 Sundays had no sales.', ref: null });
});

test('the group’s words, and each refusal’s line', () => {
  expect(SUGGESTED_COPY).toMatchObject({
    heading: 'Suggested by TownwiseAI',
    panelHeading: 'Suggested rules',
    lead: 'TownwiseAI found these in your files and sales history. Each changes nothing until someone on your team confirms it.',
    help: 'Confirm saves it as a business rule, and the forecast uses its schedule from then on. Edit changes it first. Dismiss and TownwiseAI won’t suggest it again.',
    dismissed: 'Dismissed. TownwiseAI won’t suggest it again.',
  });
  expect(toDecideLine(2)).toBe('2 to decide');
  const refusal = (status: number, code: string) => new ApiError('http', 'x', { status, code });
  expect(decideErrorLine(refusal(409, 'rule_limit'))).toBe('This location has 30 rules, the most it can hold. Delete one to confirm this.');
  expect(decideErrorLine(refusal(409, 'rule_exists'))).toBe('A rule with these words is saved without a schedule. Add the schedule to it on Business rules.');
  expect(decideErrorLine(refusal(403, 'view_as_read_only'))).toBe('View-as is read-only, so you can’t confirm or dismiss suggestions.');
  expect(decideErrorLine(refusal(429, 'rate_limited'))).toBe('You’ve made a lot of changes. Try again later.');
  expect(decideErrorLine(new Error('x'))).toBe('Couldn’t save that. Try again.');
});
