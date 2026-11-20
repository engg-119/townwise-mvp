// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions, lab/suggestions.ts), without Docker: the
// request one pass sends (one call, no tools, structured output, 8,000 tokens, exactly the input it is given), the
// checks an answer passes (at most 5 read; the note and schedule rules; tomorrow to the last day reviewed; no duplicate
// of a note, a rule, an earlier suggestion or another kept one; known calendar ids only) and the week a pass is due for.
// Then the owner-calendar events (openspec change calendar-event-suggestions): the request with and without them, the
// titles as sent (no email or phone number), the spotted events kept and the sentinel titles no kept suggestion repeats.
// D59 slice 3: each item's confidence (required in the schema sent, read leniently), a spotted event's effect choice,
// and what TownwiseAI would save of a kept suggestion it is sure of (sureChangeOf). Every date, number and title is synthetic.
import { describe, expect, it } from 'vitest';

import {
  GENERIC_TITLE_WORDS, keptSuggestions, MAX_EVENT_SUGGESTIONS, MAX_SUGGESTIONS, sentTitle, SUGGESTIONS_EVENTS_FORMAT, SUGGESTIONS_FORMAT,
  SUGGESTIONS_MAX_TOKENS, SUGGESTIONS_OWNER_EVENTS_PROMPT, SUGGESTIONS_RESERVE_MICRO_USD, SUGGESTIONS_SYSTEM_PROMPT, suggestionsRequest,
  suggestionsInput, suggestionsReserveMicroUsd, suggestionsWeek, sureChangeOf, type OwnerEventEntry, type SuggestionsContext, type SentOwnerEvent, type SuggestionChecks, type SuggestionsInput,
} from '../src/lab/suggestions.ts';
import { ceilingCostMicroUsd } from '../src/chat/pricing.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { utcDay } from '../src/dates.ts';
import { effectHistory } from '../src/forecasts/effects.ts';
import type { LocationRecord } from '../src/stores/locations.ts';
import type { NoteContent, NoteRecord } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';

const TODAY = '2026-11-16';
const TO = '2027-02-15';

const CLOSURE = {
  type: 'note', ruleText: null, kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed',
  expectedGuests: null, detail: null, startTime: null, endTime: null, why: 'Thanksgiving is Thu, Nov 26.', calendarIds: ['us:thanksgiving:2026'],
} as const;

function checks(over: Partial<SuggestionChecks> = {}): SuggestionChecks {
  return {
    today: TODAY, to: TO, notes: [], rules: [], suggested: [], calendarIds: new Set(['us:thanksgiving:2026', 'us:christmas:2026']),
    calendarTitles: new Map([['us:thanksgiving:2026', 'Thanksgiving Day'], ['us:christmas:2026', 'Christmas Day']]), ownerEvents: new Map(), ...over,
  };
}

function answer(...items: unknown[]): unknown {
  return { suggestions: items };
}

/** A note as the request sends it: every field but the title (D49), which the weekly pass never sends. */
const SENT_NOTE = {
  kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed', expectedGuests: null,
  detail: 'Sentinel-detail: family dinner', startTime: null, endTime: null,
} as const;
const NOTE: NoteContent = { ...SENT_NOTE, title: null };

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
    notes: [{ ...NOTE, title: 'Sentinel-title' }],
    rules: [{ text: 'Closed on Mondays in January', schedule: { ...SENT_NOTE, startDate: '2027-01-04', endDate: '2027-01-25', weekdays: [1] } }],
    suggested: [{ type: 'note', note: { ...NOTE, startDate: '2026-12-25', endDate: '2026-12-25', detail: null } }],
  };

  it('reserves $0.30, or the request’s ceiling at the most expensive model’s prices when that is more', () => {
    expect(suggestionsReserveMicroUsd(suggestionsRequest(input))).toBe(SUGGESTIONS_RESERVE_MICRO_USD);
    const big = suggestionsRequest({ ...input, notes: Array.from({ length: 200 }, () => ({ ...NOTE, detail: 'x'.repeat(280) })) });
    const chars = JSON.stringify(big.system).length + JSON.stringify(big.messages).length;
    const ceiling = ceilingCostMicroUsd({ input: Math.ceil(chars / 3), output: SUGGESTIONS_MAX_TOKENS, cacheRead: 0, cacheWrite: 0 });
    expect(ceiling).toBeGreaterThan(SUGGESTIONS_RESERVE_MICRO_USD);
    expect(suggestionsReserveMicroUsd(big)).toBe(ceiling);
  });

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
    expect(sent.notes).toStrictEqual([SENT_NOTE]);
    expect(sent.rules).toEqual(input.rules);
    expect(sent.alreadySuggested).toStrictEqual([{ type: 'note', ...SENT_NOTE, startDate: '2026-12-25', endDate: '2026-12-25', detail: null }]);
    expect(JSON.stringify(sent)).not.toContain('Sentinel-title');
  });

  it('sends a rule’s yearly season (D46), and the prompt says how to read one', () => {
    const season = { repeat: 'yearly', from: '01-01', to: '03-31' } as const;
    const winter = { text: 'Closed in winter', schedule: { ...SCHEDULE, startDate: '2026-11-17', endDate: null, season } };
    const [message] = suggestionsRequest({ ...input, rules: [winter] }).messages;
    const sent = JSON.parse(typeof message?.content === 'string' ? message.content : '') as { rules: unknown };
    expect(sent.rules).toEqual([winter]);
    expect(SUGGESTIONS_SYSTEM_PROMPT).toContain(
      'A rule\'s season, when set, repeats its closure on the same months and days every year from its startDate.',
    );
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

  it('drop a rule whose closure key a file or sales suggestion holds (D46), even with another start', () => {
    const standing = { ...CLOSURE, type: 'rule', ruleText: 'Shut on Thursdays', weekdays: [4], endDate: null };
    expect(keptSuggestions(answer(standing), checks({ closureKeys: new Set(['closed|w=4|ongoing']) }))).toEqual([]);
    expect(keptSuggestions(answer(standing), checks({ closureKeys: new Set(['closed|w=1|ongoing']) }))).toHaveLength(1);
    // A note is never dropped by a key.
    expect(keptSuggestions(answer(CLOSURE), checks({ closureKeys: new Set(['closed|w=*|2026-11-26..2026-11-26']) }))).toHaveLength(1);
  });

  it('a rule with a yearly season decides other days than the same schedule without one', () => {
    const asRule = { ...CLOSURE, type: 'rule', ruleText: 'Closed from Thanksgiving', endDate: null };
    const yearly = { ...SCHEDULE, endDate: null, season: { repeat: 'yearly', from: '11-26', to: '11-27' } } as const;
    expect(keptSuggestions(answer(asRule), checks({ rules: [{ text: 'Thanksgiving weekend', schedule: yearly }] }))).toHaveLength(1);
    expect(keptSuggestions(answer(asRule), checks({ rules: [{ text: 'Thanksgiving weekend', schedule: { ...yearly, season: null } }] }))).toEqual([]);
  });

  it('read at most 5 suggestions, and nothing from an answer that is not the schema', () => {
    const days = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];
    const many = days.map((date) => ({ ...CLOSURE, startDate: date, endDate: date }));
    expect(keptSuggestions(answer(...many), checks())).toHaveLength(MAX_SUGGESTIONS);
    expect(MAX_SUGGESTIONS).toBe(5);
    for (const bad of [null, 'text', { suggestions: 'none' }, []]) expect(keptSuggestions(bad, checks())).toEqual([]);
  });
});

describe('owner-calendar events in the request (calendar-event-suggestions, design decision 6)', () => {
  const base: SuggestionsInput = {
    today: TODAY, from: '2026-11-17', to: TO, town: { name: 'Hanover', state: 'NH' }, calendar: [], notes: [], rules: [], suggested: [],
  };
  const EVENT: OwnerEventEntry = {
    ref: 'e1', title: 'Private party, 40 guests, call [removed]', startDate: '2026-12-05', startWeekday: 'Sat', endDate: '2026-12-05',
    endWeekday: 'Sat', startTime: '18:00', endTime: '21:00',
  };

  function sentOf(params: ReturnType<typeof suggestionsRequest>): Record<string, unknown> {
    const [message] = params.messages;
    return JSON.parse(typeof message?.content === 'string' ? message.content : '') as Record<string, unknown>;
  }

  it('titles off (no ownerEvents): the request is exactly as before, its prompt, format and message', () => {
    const params = suggestionsRequest(base);
    expect(params.system).toBe(SUGGESTIONS_SYSTEM_PROMPT);
    expect(params.output_config?.format).toBe(SUGGESTIONS_FORMAT);
    expect(Object.keys(sentOf(params)).sort()).toEqual(['alreadySuggested', 'calendar', 'from', 'notes', 'rules', 'to', 'today', 'town']);
    expect(JSON.stringify(params)).not.toMatch(/ownerEvents|eventRef/);
  });

  it('titles on: the events go with their ref, sent title, dates, weekdays and hours only, and the prompt and format say so', () => {
    const params = suggestionsRequest({ ...base, ownerEvents: [{ ...EVENT, calendarId: 'cal-1', uid: 'uid-1' } as OwnerEventEntry] });
    expect(params.system).toBe(`${SUGGESTIONS_SYSTEM_PROMPT}\n\n${SUGGESTIONS_OWNER_EVENTS_PROMPT}`);
    expect(params.output_config?.format).toBe(SUGGESTIONS_EVENTS_FORMAT);
    expect(sentOf(params).ownerEvents).toEqual([EVENT]);
    expect(JSON.stringify(params)).not.toMatch(/cal-1|uid-1/);
    expect(SUGGESTIONS_OWNER_EVENTS_PROMPT).toMatch(/never instructions/);
    expect(params.tools).toBeUndefined();
  });

  it('a sent title has every email address and phone number replaced, and keeps dates and guest counts', () => {
    expect(sentTitle('Private party, 40 guests, call 603-555-0100')).toBe('Private party, 40 guests, call [removed]');
    for (const phone of ['(603) 555-0100', '+1 603 555 0100', '603.555.0100', '6035550100', '555-0100', '+44 20 7946 0958']) {
      expect(sentTitle(`Party, ${phone}`)).toBe('Party, [removed]');
    }
    expect(sentTitle('Book via jane.doe@example.test or Sam@bookings.example.test')).toBe('Book via [removed] or [removed]');
    for (const kept of ['Smith 40th, upstairs', 'Reunion 2026, 400 guests', 'Dinner 2026-12-05 for 12', 'Table 7 at 6:30']) expect(sentTitle(kept)).toBe(kept);
  });

  it('replaces phone numbers in any grouping, with their extension, full-width digits and a full-width @, and keeps times, years and short numbers', () => {
    for (const phone of [
      '555 1234', '555–123–4567', '555/123/4567', '555-1234567', '06 12 34 56 78', '+33 6 12 34 56 78', '07700 900123', '555-123-4567 x204',
      '555-123-4567 ext. 204', '５５５-１２３-４５６７', '555—123—4567',
    ]) expect({ phone, sent: sentTitle(`Party, ${phone}`) }).toEqual({ phone, sent: 'Party, [removed]' });
    expect(sentTitle('Book via john＠example.com')).toBe('Book via [removed]');
    for (const kept of ['Party 40 1730-2200', 'Gala 2026 1800-2200', 'Party 25 100 200', 'Dec 5 6pm 40 guests', 'Party 4 x 5', 'Reunion 2026 400 guests']) {
      expect(sentTitle(kept)).toBe(kept);
    }
    expect(sentTitle('Party 1730-2200, call 555-1234')).toBe('Party 1730-2200, call [removed]');
  });
});

describe('the checks on spotted events and sent titles (calendar-event-suggestions, design decision 7)', () => {
  /** A sent owner event on `date`, 6 pm to 9 pm. */
  function sent(title: string, date = '2026-12-05', uid = `uid-${date}`): SentOwnerEvent {
    return { calendarId: 'c'.repeat(24), uid, title, startDate: date, endDate: date, startTime: '18:00', endTime: '21:00' };
  }
  const ownerEvents = new Map([
    ['e1', sent('Private party, 40 guests, call [removed]')],
    ['e2', sent('Jones reception', '2026-12-12')],
    ['e3', sent('Zyxwvut rehearsal dinner', '2026-12-19')],
  ]);
  const eventItem = (ref: string, over: Record<string, unknown> = {}) => ({
    ...CLOSURE, type: 'event', kind: 'private_event', effect: 'unknown', startDate: '2026-11-20', endDate: '2026-11-20', eventRef: ref,
    why: 'Sentinel model why', detail: 'Sentinel model detail', expectedGuests: null, ...over,
  });

  it('keeps a spotted event with the event’s dates and hours, effect unknown, the title’s count, and no why or detail', () => {
    const kept = keptSuggestions(answer(eventItem('e1', { expectedGuests: 40 })), checks({ ownerEvents }));
    expect(kept).toEqual([{
      content: {
        type: 'event',
        note: { kind: 'private_event', startDate: '2026-12-05', endDate: '2026-12-05', weekdays: null, effect: 'unknown', expectedGuests: 40, detail: null, title: null, startTime: '18:00', endTime: '21:00' },
        event: { calendarId: 'c'.repeat(24), uid: 'uid-2026-12-05', startDate: '2026-12-05', endDate: '2026-12-05', startTime: '18:00', endTime: '21:00' },
      },
      why: null, calendarIds: [],
    }]);
    expect(JSON.stringify(kept)).not.toContain('Sentinel model');
  });

  it('keeps no title a model answer tries to give a spotted event or a note (D49): a stored suggestion carries none', () => {
    const titled = { title: 'Sentinel model title' };
    const town = { ...CLOSURE, ...titled };
    const kept = keptSuggestions(answer(eventItem('e1', { expectedGuests: 40, ...titled })), checks({ ownerEvents }));
    expect(kept.map((each) => each.content.type === 'rule' ? 'rule' : each.content.note.title)).toEqual([null]);
    const notes = keptSuggestions(answer(town), checks());
    expect(notes.map((each) => each.content.type === 'rule' ? 'rule' : each.content.note.title)).toEqual([null]);
    expect(JSON.stringify([kept, notes])).not.toContain('Sentinel model title');
  });

  it('keeps a count only when the sent title says it beside a guest word', () => {
    const counted = (title: string, guests: number): number | null => {
      const [one] = keptSuggestions(answer(eventItem('e1', { expectedGuests: guests })), checks({ ownerEvents: new Map([['e1', sent(title)]]) }));
      return one?.content.type === 'event' ? one.content.note.expectedGuests : null;
    };
    expect(counted('Smith party, 40 guests', 40)).toBe(40);
    expect(counted('Smith party 25 people', 25)).toBe(25);
    expect(counted('Smith party 12 ppl', 12)).toBe(12);
    expect(counted('Smith party 30 pax', 30)).toBe(30);
    expect(counted('Smith party of 8', 8)).toBe(8);
    expect(counted('Dinner for 12', 12)).toBe(12);
    expect(counted('Gala 2026', 2026)).toBeNull();
    expect(counted('Party 40 1730-2200', 40)).toBeNull();
    expect(counted('Table 7 at 6:30', 7)).toBeNull();
    expect(counted('Dinner for 6:30', 6)).toBeNull();
  });

  it('nulls a guessed count, and drops a forged ref, a reused one, and an event item when no event was sent', () => {
    const [jones] = keptSuggestions(answer(eventItem('e2', { expectedGuests: 60 })), checks({ ownerEvents }));
    expect(jones?.content).toMatchObject({ type: 'event', note: { expectedGuests: null, startDate: '2026-12-12' } });
    expect(keptSuggestions(answer(eventItem('e99'), eventItem('uid-2026-12-05')), checks({ ownerEvents }))).toEqual([]);
    expect(keptSuggestions(answer(eventItem('e1'), eventItem('e1', { expectedGuests: 40 })), checks({ ownerEvents }))).toHaveLength(1);
    expect(keptSuggestions(answer(eventItem('e1')), checks())).toEqual([]);
  });

  it('drops a spotted event over a closure or private-event note, but not over another kind of note', () => {
    const over = (kind: NoteContent['kind'], effect: NoteContent['effect']): NoteContent => ({ ...NOTE, kind, effect, startDate: '2026-12-04', endDate: '2026-12-06', detail: null });
    expect(keptSuggestions(answer(eventItem('e1')), checks({ ownerEvents, notes: [over('closure', 'closed')] }))).toEqual([]);
    expect(keptSuggestions(answer(eventItem('e1')), checks({ ownerEvents, notes: [over('private_event', 'more_guests')] }))).toEqual([]);
    expect(keptSuggestions(answer(eventItem('e1')), checks({ ownerEvents, notes: [over('opening', 'fewer_guests')] }))).toHaveLength(1);
  });

  it('reads at most 5 spotted events apart from the 5 notes and rules', () => {
    const many = new Map(Array.from({ length: 6 }, (_, index) => {
      const date = `2026-12-${String(index + 1).padStart(2, '0')}`;
      return [`e${String(index + 1)}`, sent(`Private party ${String(index + 1)}`, date)] as const;
    }));
    const closures = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((date) => ({ ...CLOSURE, startDate: date, endDate: date }));
    const events = [...many.keys()].map((ref) => eventItem(ref));
    const kept = keptSuggestions(answer(...events.slice(0, 3), ...closures, ...events.slice(3)), checks({ ownerEvents: many }));
    expect(kept.filter((each) => each.content.type === 'event')).toHaveLength(MAX_EVENT_SUGGESTIONS);
    expect(kept.filter((each) => each.content.type === 'note')).toHaveLength(MAX_SUGGESTIONS);
    expect(MAX_EVENT_SUGGESTIONS).toBe(5);
  });

  it('with events sent, drops a private-event note or rule and any item repeating a sent title’s distinctive word, keeping generic and town words', () => {
    const withTown = checks({
      ownerEvents: new Map([...ownerEvents, ['e4', sent('Commencement brunch for the Qwertyx group', '2026-12-26')]]),
      calendarIds: new Set(['us:thanksgiving:2026', 'town:commencement']),
      calendarTitles: new Map([['us:thanksgiving:2026', 'Thanksgiving Day'], ['town:commencement', 'Commencement']]),
    });
    const party = { ...CLOSURE, kind: 'private_event', effect: 'more_guests', expectedGuests: 30, startDate: '2026-11-28', endDate: '2026-11-28', why: 'A party.' };
    const named = { ...CLOSURE, why: 'The Zyxwvut family closes it for Thanksgiving.' };
    const detailed = { ...CLOSURE, startDate: '2026-11-27', endDate: '2026-11-27', detail: 'For ZYXWVUT', why: 'Closed after Thanksgiving.' };
    const rule = { ...CLOSURE, type: 'rule', ruleText: 'Closed for Qwertyx', startDate: '2026-11-29', endDate: '2026-11-29', why: 'Sundays.' };
    expect(keptSuggestions(answer(party, named, detailed, rule), withTown)).toEqual([]);
    // Generic event and food words, and a town calendar entry's words, pass.
    const holiday = { ...CLOSURE, why: 'Thanksgiving draws a holiday dinner crowd elsewhere.' };
    const town = { ...CLOSURE, startDate: '2026-11-30', endDate: '2026-11-30', why: 'Commencement brunch week closes the street.', calendarIds: ['town:commencement'] };
    expect(keptSuggestions(answer(holiday, town), withTown).map((each) => each.why)).toEqual([holiday.why, town.why]);
    expect(GENERIC_TITLE_WORDS.has('dinner')).toBe(true);
    // Without events sent, a private-event note is suggested as before.
    expect(keptSuggestions(answer(party), checks())).toHaveLength(1);
  });

  it('with events sent, keeps a note or rule only when it cites a town calendar entry the request sent', () => {
    expect(keptSuggestions(answer({ ...CLOSURE, calendarIds: [] }, { ...CLOSURE, startDate: '2026-11-27', endDate: '2026-11-27', calendarIds: ['made-up'] }), checks({ ownerEvents }))).toEqual([]);
    expect(keptSuggestions(answer(CLOSURE), checks({ ownerEvents }))).toHaveLength(1);
    expect(keptSuggestions(answer({ ...CLOSURE, calendarIds: [] }), checks())).toHaveLength(1);
  });

  it('drops a why naming an owner title however it is spelled, cased, split, joined or accented, and one holding 7 digits in a row', () => {
    const names = new Map([
      ['e1', sent('Ng buyout', '2026-12-05')], ['e2', sent('Johnsons 50th', '2026-12-06')], ['e3', sent('Smith-Jones rehearsal', '2026-12-07')],
      ['e4', sent('McDonald retirement', '2026-12-08')], ['e5', sent('Bo Kim 30', '2026-12-09')], ['e6', sent('Rodríguez quinceañera', '2026-12-10')],
    ]);
    const whys = [
      'Closed for the Ng buyout.', 'Closed for Johnson.', 'Closed for SmithJones.', 'Closed for Mc Donald.', 'Closed for Bo Kim.',
      'Closed for Rodriguez quinceanera.', 'Closed for SMITH.', 'Closed for Ｊｏｎｅｓ.', 'Call 5551234 first.',
    ];
    for (const why of whys) expect({ why, kept: keptSuggestions(answer({ ...CLOSURE, why }), checks({ ownerEvents: names })) }).toEqual({ why, kept: [] });
    expect(keptSuggestions(answer({ ...CLOSURE, detail: 'For the Johnson’s' }), checks({ ownerEvents: names }))).toEqual([]);
    expect(keptSuggestions(answer({ ...CLOSURE, detail: 'For the family' }), checks({ ownerEvents: names }))).toHaveLength(1);
    // A closure citing a town entry, its why naming only that entry, stays; an entry it does not cite is not exempt.
    const town = checks({
      ownerEvents: new Map([['e1', sent('Thanksgiving Day Commencement buyout', '2026-12-05')]]),
      calendarIds: new Set(['us:thanksgiving:2026', 'town:commencement']),
      calendarTitles: new Map([['us:thanksgiving:2026', 'Thanksgiving Day'], ['town:commencement', 'Commencement']]),
    });
    expect(keptSuggestions(answer({ ...CLOSURE, why: 'Thanksgiving Day closes the town, and you were closed for it last year.' }), town)).toHaveLength(1);
    expect(keptSuggestions(answer({ ...CLOSURE, why: 'Commencement is that week.' }), town)).toEqual([]);
  });

  it('sentinel titles: no distinctive word of a sent title is in any kept suggestion', () => {
    const items = [
      eventItem('e3', { why: 'Zyxwvut rehearsal dinner', detail: 'Zyxwvut' }),
      { ...CLOSURE, why: 'Zyxwvut is closed then.' },
      { ...CLOSURE, startDate: '2026-11-27', endDate: '2026-11-27', why: 'Closed the day after Thanksgiving.' },
    ];
    const kept = keptSuggestions(answer(...items), checks({ ownerEvents }));
    expect(kept.map((each) => each.content.type)).toEqual(['note', 'event']);
    expect(JSON.stringify(kept).toLowerCase()).not.toContain('zyxwvut');
    expect(JSON.stringify(kept).toLowerCase()).not.toContain('jones');
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

describe('confidence and what TownwiseAI is sure of (D59 slice 3)', () => {
  const ownerEvents = new Map([['e1', {
    calendarId: 'c'.repeat(24), uid: 'uid-1', title: 'Private party, 40 guests', startDate: '2026-12-05', endDate: '2026-12-05', startTime: '18:00', endTime: '21:00',
  }]]);
  const spot = (over: Record<string, unknown>) => ({
    ...CLOSURE, type: 'event', kind: 'private_event', effect: 'unknown', startDate: '2026-12-05', endDate: '2026-12-05', eventRef: 'e1', why: '',
    expectedGuests: 40, ...over,
  });

  it('the schema sent requires a confidence on every item, and the prompt says only a high one is saved on its own', () => {
    /** The schema object whose properties hold `confidence` (an item's), wherever the generator put it. */
    const itemOf = (node: unknown): { required?: string[]; properties: Record<string, unknown> } | null => {
      if (typeof node !== 'object' || node === null) return null;
      const props = (node as { properties?: Record<string, unknown> }).properties;
      if (props !== undefined && 'confidence' in props) return node as { required?: string[]; properties: Record<string, unknown> };
      for (const value of Object.values(node)) {
        const found = itemOf(value);
        if (found !== null) return found;
      }
      return null;
    };
    for (const format of [SUGGESTIONS_FORMAT, SUGGESTIONS_EVENTS_FORMAT]) {
      const item = itemOf(format.schema);
      expect(item?.required).toContain('confidence');
      expect(JSON.stringify(item?.properties.confidence)).toMatch(/high.*medium.*low/);
    }
    expect(SUGGESTIONS_SYSTEM_PROMPT).toContain('Rate each one\'s confidence: "high" only when');
    expect(SUGGESTIONS_SYSTEM_PROMPT).not.toContain('nothing you suggest changes the forecast until they accept it');
    expect(SUGGESTIONS_OWNER_EVENTS_PROMPT).toContain('effect is closed when the title says the party takes the whole restaurant');
  });

  it('keeps a known confidence and an event’s chosen effect, and nothing for none or an unknown value', () => {
    const [high, unknown, none] = keptSuggestions(answer(
      { ...CLOSURE, confidence: 'high' }, { ...CLOSURE, startDate: '2026-11-27', endDate: '2026-11-27', confidence: 'certain' },
      { ...CLOSURE, startDate: '2026-11-28', endDate: '2026-11-28' },
    ), checks());
    expect(high).toMatchObject({ confidence: 'high' });
    expect(unknown).not.toHaveProperty('confidence');
    expect(none).not.toHaveProperty('confidence');
    const [event] = keptSuggestions(answer(spot({ effect: 'closed', confidence: 'high' })), checks({ ownerEvents }));
    expect(event).toMatchObject({ confidence: 'high', choice: 'closed', content: { type: 'event', note: { effect: 'unknown' } } });
  });

  it('is sure of a high note, a high closure rule and a high event with its effect; never a medium one, another rule, or an unchosen event', () => {
    const keep = (item: unknown, over: Partial<SuggestionChecks> = {}) => keptSuggestions(answer(item), checks(over))[0];
    const sure = (item: unknown, over: Partial<SuggestionChecks> = {}) => {
      const kept = keep(item, over);
      return kept === undefined ? undefined : sureChangeOf(kept, TODAY);
    };
    expect(sure({ ...CLOSURE, confidence: 'high' })).toMatchObject({ type: 'note', event: null, note: { kind: 'closure', startDate: '2026-11-26' } });
    expect(sure({ ...CLOSURE, confidence: 'medium' })).toBeNull();
    expect(sure({ ...CLOSURE, type: 'rule', ruleText: 'Closed on Thanksgiving', confidence: 'high' }))
      .toMatchObject({ type: 'rule', text: 'Closed on Thanksgiving', schedule: { kind: 'closure' } });
    expect(sure({ ...CLOSURE, type: 'rule', ruleText: 'Busy on Thanksgiving', kind: 'other', effect: 'more_guests', confidence: 'high' })).toBeNull();
    expect(sure(spot({ effect: 'closed', confidence: 'high' }), { ownerEvents }))
      .toMatchObject({ type: 'note', note: { kind: 'private_event', effect: 'closed', expectedGuests: 40, startTime: '18:00' }, event: { uid: 'uid-1' } });
    expect(sure(spot({ effect: 'more_guests', confidence: 'high' }), { ownerEvents })).toMatchObject({ note: { effect: 'more_guests', expectedGuests: 40 } });
    // Alongside regular service with no count the title states, or no choice, waits for an admin.
    expect(sure(spot({ effect: 'more_guests', confidence: 'high', expectedGuests: 12 }), { ownerEvents })).toBeNull();
    expect(sure(spot({ effect: 'unknown', confidence: 'high' }), { ownerEvents })).toBeNull();
    expect(sure(spot({ effect: 'closed', confidence: 'medium' }), { ownerEvents })).toBeNull();
    // Design decision 7's 14-day guard: a closed note over 14 days, or a rule closing more than 14 days in a row, waits.
    expect(sure({ ...CLOSURE, endDate: '2026-12-09', confidence: 'high' })).toMatchObject({ type: 'note' });
    expect(sure({ ...CLOSURE, endDate: '2026-12-10', confidence: 'high' })).toBeNull();
    const rule = { ...CLOSURE, type: 'rule', ruleText: 'Closed for winter', confidence: 'high' };
    expect(sure({ ...rule, endDate: null })).toBeNull();
    expect(sure({ ...rule, endDate: null, weekdays: [1, 2, 3, 4, 5, 6] })).toMatchObject({ type: 'rule' });
    expect(sure({ ...rule, endDate: null, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBeNull();
  });
});


describe('suggestionsInput and a guest count marked wrong (D67)', () => {
  // Thanksgiving 2025 had 0 guests but real sales against Thursdays of 100: likely closed, unless its count is marked wrong.
  const today = '2026-11-12';
  const location: LocationRecord = { id: 'l1', name: 'Taproom', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, placeId: null, createdAt: new Date(0) };
  const history = effectHistory(today);
  const days: SalesDay[] = [];
  for (let date = history.readFrom; date <= history.to; date = utcDay(new Date(`${date}T00:00:00.000Z`), 1)) {
    days.push({ date, guests: date === '2025-11-27' ? 0 : 100, netSalesCents: 200_000 });
  }
  const mark = {
    id: 'm1', kind: 'other', startDate: '2025-11-27', endDate: '2025-11-27', weekdays: null, effect: 'wrong_guest_count', expectedGuests: null,
    detail: null, title: null, startTime: null, endTime: null,
  } as unknown as NoteRecord;

  async function thanksgiving(notes: readonly NoteRecord[]): Promise<SuggestionsInput['calendar'][number] | undefined> {
    const overlapping = (_scope: unknown, _id: string, range: { from: string; to: string }) =>
      Promise.resolve(notes.filter((note) => note.startDate <= range.to && note.endDate >= range.from));
    const stores = {
      notes: { overlapping },
      businessRules: { list: () => Promise.resolve([]) },
      salesDays: {
        days: (_scope: unknown, _id: string, range: { from: string; to: string }) => Promise.resolve(days.filter((day) => day.date >= range.from && day.date <= range.to)),
        coverage: () => Promise.resolve({ firstDate: days[0]?.date ?? null, lastDate: days.at(-1)?.date ?? null }),
      },
    } as unknown as SuggestionsContext['stores'];
    const { input } = await suggestionsInput({ stores }, {} as OrgScope, location, today, [], { titles: false });
    return input.calendar.find((entry) => entry.start === '2026-11-26' && entry.kind === 'holiday');
  }

  it('counts a marked past occurrence as open, not closed, and takes it out of the history effect', async () => {
    expect((await thanksgiving([]))?.pastDays).toEqual({ open: 0, closed: 1, noSales: 0 });
    expect((await thanksgiving([mark]))?.pastDays).toEqual({ open: 1, closed: 0, noSales: 0 });
    expect((await thanksgiving([mark]))?.history).toBeNull();
  });
});
