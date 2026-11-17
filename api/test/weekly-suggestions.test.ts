// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions, lab/suggestions.ts), without Docker: the
// request one pass sends (one call, no tools, structured output, 8,000 tokens, exactly the input it is given), the
// checks an answer passes (at most 5 read; the note and schedule rules; tomorrow to the last day reviewed; no duplicate
// of a note, a rule, an earlier suggestion or another kept one; known calendar ids only) and the week a pass is due for.
// Every date and number is synthetic.
import { describe, expect, it } from 'vitest';

import {
  keptSuggestions, MAX_SUGGESTIONS, SUGGESTIONS_MAX_TOKENS, suggestionsRequest, suggestionsWeek, type SuggestionChecks, type SuggestionsInput,
} from '../src/lab/suggestions.ts';
import type { NoteContent } from '../src/stores/notes.ts';

const TODAY = '2026-11-16';
const TO = '2027-02-15';

const CLOSURE = {
  type: 'note', ruleText: null, kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed',
  expectedGuests: null, detail: null, startTime: null, endTime: null, why: 'Thanksgiving is Thu, Nov 26.', calendarIds: ['us:thanksgiving:2026'],
} as const;

function checks(over: Partial<SuggestionChecks> = {}): SuggestionChecks {
  return {
    today: TODAY, to: TO, notes: [], rules: [], suggested: [], calendarIds: new Set(['us:thanksgiving:2026', 'us:christmas:2026']), ...over,
  };
}

function answer(...items: unknown[]): unknown {
  return { suggestions: items };
}

const NOTE: NoteContent = {
  kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed', expectedGuests: null,
  detail: 'Sentinel-detail: family dinner', startTime: null, endTime: null,
};

const SCHEDULE = {
  kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
} as const;

describe('the request', () => {
  const input: SuggestionsInput = {
    today: TODAY, from: '2026-11-17', to: TO, town: { name: 'Hanover', state: 'NH' },
    calendar: [{
      id: 'us:thanksgiving:2026', title: 'Thanksgiving Day', start: '2026-11-26', startWeekday: 'Thu', end: '2026-11-26', endWeekday: 'Thu',
      kind: 'holiday', scope: 'national', groupLabel: 'Thanksgiving', confidence: null, sources: [],
      history: { direction: 'fewer', pct: 40, days: 1 }, pastDays: { open: 0, closed: 1, noSales: 0 },
    }],
    notes: [NOTE],
    rules: [{ text: 'Closed on Mondays in January', schedule: { ...NOTE, startDate: '2027-01-04', endDate: '2027-01-25', weekdays: [1] } }],
    suggested: [{ type: 'note', note: { ...NOTE, startDate: '2026-12-25', endDate: '2026-12-25', detail: null } }],
  };

  it('is one call with no tools, low effort, structured output and 8,000 output tokens', () => {
    const params = suggestionsRequest(input);
    expect(params).toMatchObject({ model: 'claude-opus-5-5', max_tokens: SUGGESTIONS_MAX_TOKENS, output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(SUGGESTIONS_MAX_TOKENS).toBe(8000);
    expect(params.tools).toBeUndefined();
    expect(params.messages).toHaveLength(1);
  });

  it('sends exactly the input: the calendar with its history, the notes and rules as written, and what it suggested before', () => {
    const [message] = suggestionsRequest(input).messages;
    const sent = JSON.parse(typeof message?.content === 'string' ? message.content : '') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['alreadySuggested', 'calendar', 'from', 'notes', 'rules', 'to', 'today', 'town']);
    expect(sent.calendar).toEqual(input.calendar);
    expect(sent.notes).toEqual([NOTE]);
    expect(sent.rules).toEqual(input.rules);
    expect(sent.alreadySuggested).toEqual([{ type: 'note', ...NOTE, startDate: '2026-12-25', endDate: '2026-12-25', detail: null }]);
  });
});

describe('the checks', () => {
  it('keep a valid closure note, with its why and only the calendar ids the request sent', () => {
    const kept = keptSuggestions(answer({ ...CLOSURE, calendarIds: ['us:thanksgiving:2026', 'made-up', 'us:thanksgiving:2026'] }), checks());
    expect(kept).toEqual([{
      content: { type: 'note', note: { ...NOTE, detail: null } }, why: 'Thanksgiving is Thu, Nov 26.', calendarIds: ['us:thanksgiving:2026'],
    }]);
  });

  it('keep a rule with its words and schedule, its end null for no end', () => {
    const rule = { ...CLOSURE, type: 'rule', ruleText: '  Closed on   Thanksgiving ', endDate: null };
    expect(keptSuggestions(answer(rule), checks())).toEqual([{
      content: {
        type: 'rule', text: 'Closed on Thanksgiving',
        schedule: { kind: 'closure', startDate: '2026-11-26', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
      },
      why: CLOSURE.why, calendarIds: ['us:thanksgiving:2026'],
    }]);
  });

  it('drop what the note or schedule rules refuse: an end before the start, guests on a closure, hours on a closure, other without detail', () => {
    const refused = [
      { ...CLOSURE, endDate: '2026-11-25' },
      { ...CLOSURE, expectedGuests: 12 },
      { ...CLOSURE, startTime: '10:00', endTime: '12:00' },
      { ...CLOSURE, kind: 'other', effect: 'more_guests' },
      { ...CLOSURE, weekdays: [1, 1] },
      { ...CLOSURE, type: 'rule', ruleText: null },
      { ...CLOSURE, type: 'rule', ruleText: 'Closed', detail: 'a detail on a rule' },
      { ...CLOSURE, startDate: 'Thanksgiving' },
      { ...CLOSURE, why: '   ' },
      { ...CLOSURE, why: 'x'.repeat(281) },
      { ...CLOSURE, type: 'reminder' },
      'not an object',
    ];
    expect(keptSuggestions(answer(...refused), checks())).toEqual([]);
  });

  it('drop a suggestion before tomorrow in the town or after the last day reviewed', () => {
    const at = (date: string) => ({ ...CLOSURE, startDate: date, endDate: date });
    expect(keptSuggestions(answer(at(TODAY), at('2027-02-16')), checks())).toEqual([]);
    expect(keptSuggestions(answer(at('2026-11-17'), at(TO)), checks())).toHaveLength(2);
  });

  it('drop a duplicate of a note, a rule’s schedule or words, an earlier suggestion, or one already kept', () => {
    const asRule = { ...CLOSURE, type: 'rule', ruleText: 'Closed on Thanksgiving', endDate: '2026-11-26' };
    expect(keptSuggestions(answer(CLOSURE), checks({ notes: [NOTE] }))).toEqual([]);
    expect(keptSuggestions(answer(CLOSURE), checks({ rules: [{ text: 'Closed on Thanksgiving', schedule: SCHEDULE }] }))).toEqual([]);
    expect(keptSuggestions(answer({ ...asRule, startDate: '2026-11-27', endDate: '2026-11-27' }), checks({ rules: [{ text: 'closed on thanksgiving', schedule: null }] }))).toEqual([]);
    expect(keptSuggestions(answer(CLOSURE), checks({ suggested: [{ type: 'note', note: NOTE }] }))).toEqual([]);
    expect(keptSuggestions(answer(CLOSURE, { ...CLOSURE, why: 'Again.' }, asRule), checks())).toHaveLength(1);
  });

  it('read at most 5 suggestions, and nothing from an answer that is not the schema', () => {
    const days = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];
    const many = days.map((date) => ({ ...CLOSURE, startDate: date, endDate: date }));
    expect(keptSuggestions(answer(...many), checks())).toHaveLength(MAX_SUGGESTIONS);
    expect(MAX_SUGGESTIONS).toBe(5);
    for (const bad of [null, 'text', { suggestions: 'none' }, []]) expect(keptSuggestions(bad, checks())).toEqual([]);
  });
});

describe('the week a pass is due for', () => {
  it('is the Monday of the town’s week, from 03:00 on Monday through Sunday', () => {
    expect(suggestionsWeek('2026-11-16', 2 * 60 + 59, 3)).toBeNull();
    expect(suggestionsWeek('2026-11-16', 3 * 60, 3)).toBe('2026-11-16');
    expect(suggestionsWeek('2026-11-18', 0, 3)).toBe('2026-11-16');
    expect(suggestionsWeek('2026-11-22', 23 * 60, 3)).toBe('2026-11-16');
    expect(suggestionsWeek('2026-11-23', 4 * 60, 3)).toBe('2026-11-23');
  });
});
