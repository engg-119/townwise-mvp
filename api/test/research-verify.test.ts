// The checks between the extract's answer and a thread's findings (D66 design decision 5, task 1.4): each drop reason
// counted, safeText on titles, entity names (entity dropped, event kept) and source labels (host kept), grounding (a
// quote on another source's text is ungrounded, a recurrence by weekday names, stale pages), the confidence table and
// the lower-of rule. Synthetic pages only.
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { buildLedger } from '../src/research/ledger.ts';
import {
  EXTRACT_FORMAT, codeConfidence, grounded, lowerOf, mentionsDate, pageDate, safeText, verifyExtract, type VerifyContext,
} from '../src/research/verify.ts';
import { citedQuotes, docCited, fetchResult, message, webResults, webSearch } from './helpers/chat-model.ts';

const NOW = new Date('2026-11-19T15:00:00Z');
const WINDOW = { from: '2026-11-19', to: '2027-05-18' };
const FAIR = 'https://www.example.com/fair';
const NEWS = 'https://news.example.org/fair';
const MARKET = 'https://market.example.net/schedule';
const OLD = 'https://old.example.edu/archive';

/** S1 FAIR and S2 NEWS cite "Saturday, May 15"; S3 MARKET is a fetched page; S4 OLD is an old page citing "May 15". */
function ledger(): ReturnType<typeof buildLedger> {
  const results = webResults('s1', [FAIR, NEWS]);
  const old: BetaContentBlock = {
    type: 'web_search_tool_result', tool_use_id: 's2', caller: { type: 'direct' },
    content: [{ type: 'web_search_result', title: 'Archive', url: OLD, encrypted_content: 'x', page_age: 'March 1, 2025' }],
  };
  return buildLedger([message([
    webSearch('s1'), results,
    fetchResult('f1', MARKET, 'The farmers market runs every Wednesday, 3 to 6 pm, through the spring.'),
    webSearch('s2'), old,
    citedQuotes('EVENT: the fair.', [{ url: FAIR, quote: 'The fair is on Saturday, May 15, 2027.' }, { url: NEWS, quote: 'Saturday, May 15 brings the fair' }]),
    citedQuotes('EVENT: old fair.', [{ url: OLD, quote: 'Fair on May 15' }]),
    docCited('EVENT: market.', [{ documentIndex: 0, quote: 'every Wednesday, 3 to 6 pm' }]),
  ])]);
}

function context(over: Partial<VerifyContext> = {}): VerifyContext {
  return { ledger: ledger(), window: WINDOW, competitors: [], now: NOW, ...over };
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Town Fair', kind: 'event', category: 'festival', startDate: '2027-05-15', endDate: '2027-05-15', weekdays: null,
    startTime: '10:00', status: 'scheduled', venueRef: null, hostRef: null, competitor: null, sourceIds: ['S1'],
    dateQuote: 'Saturday, May 15', confidence: 'high', ...over,
  };
}

function entity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ref: 'e1', type: 'venue', name: 'Town Green', sourceIds: ['S1'], ...over };
}

function verify(events: unknown[], entities: unknown[] = [], over: Partial<VerifyContext> = {}): NonNullable<ReturnType<typeof verifyExtract>> {
  const verified = verifyExtract({ events, entities }, context(over));
  if (verified === null) throw new Error('unreadable answer');
  return verified;
}

describe('safeText', () => {
  it.each([
    ['Trivia night, call 603-555-0100', null],
    ['Call (603) 555-0100', null],
    ['Book at example.com', null],
    ['See https://example.org', null],
    ['www.fair.org', null],
    ['Write to fair@example.org', null],
    ['Fair​day', null],
    ['Fair\u0007', null],
    ['   ', null],
    ['x'.repeat(121), null],
    ['  Winter Carnival 2027  ', 'Winter Carnival 2027'],
    ['St. Louis Blues night', 'St. Louis Blues night'],
    ['Class of 2026-2027 reunion', 'Class of 2026-2027 reunion'],
    ['Route 120 paving, 7 a.m. to 5 p.m.', 'Route 120 paving, 7 a.m. to 5 p.m.'],
  ])('%j answers %j', (value, expected) => {
    expect(safeText(value, 120)).toBe(expected);
  });
});

describe('mentionsDate', () => {
  it.each([
    ['Saturday, May 15', true],
    ['the 15th of May', true],
    ['on 5/15', true],
    ['2027-05-15', true],
    ['May 16', false],
    ['May 1', false],
    ['Saturday', false],
  ])('%j for 2027-05-15: %s', (quote, expected) => {
    expect(mentionsDate(quote, '2027-05-15', null)).toBe(expected);
  });

  it('reads a recurrence by its weekday names', () => {
    expect(mentionsDate('every wednesday, 3 to 6 pm', '2026-11-25', [3])).toBe(true);
    expect(mentionsDate('tues and thurs nights', '2026-11-24', [2, 4])).toBe(true);
    expect(mentionsDate('tuesday nights', '2026-11-24', [2, 4])).toBe(false);
    expect(mentionsDate('every wednesday', '2026-11-25', null)).toBe(false);
  });
});

describe('pageDate', () => {
  it('reads relative and absolute ages, and nothing else', () => {
    expect(pageDate('3 days ago', NOW)?.toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(pageDate('2 weeks ago', NOW)?.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(pageDate('March 1, 2025', NOW)?.getFullYear()).toBe(2025);
    expect(pageDate('recently', NOW)).toBeNull();
    expect(pageDate(null, NOW)).toBeNull();
  });
});

describe('grounding and confidence', () => {
  const sources = (...ids: string[]) => ids.map((id) => {
    const source = ledger().byId(id);
    if (source === undefined) throw new Error(id);
    return source;
  });

  it('grounds a quote in its own source\'s cited words, normalized', () => {
    expect(grounded({ dateQuote: '“Saturday,   May 15”.', startDate: '2027-05-15', weekdays: null }, sources('S1'), NOW)).toBe(true);
  });

  it('does not ground a quote found only in another source\'s text', () => {
    expect(grounded({ dateQuote: 'Saturday, May 15 brings the fair', startDate: '2027-05-15', weekdays: null }, sources('S1'), NOW)).toBe(false);
    expect(grounded({ dateQuote: 'Saturday, May 15 brings the fair', startDate: '2027-05-15', weekdays: null }, sources('S2'), NOW)).toBe(true);
  });

  it('grounds in a fetched page\'s text, and needs the quote to state the start date', () => {
    expect(grounded({ dateQuote: 'every Wednesday, 3 to 6 pm', startDate: '2026-11-25', weekdays: [3] }, sources('S3'), NOW)).toBe(true);
    expect(grounded({ dateQuote: 'runs every Wednesday', startDate: '2026-11-25', weekdays: null }, sources('S3'), NOW)).toBe(false);
  });

  it('does not ground a quote with no year when every source is more than 9 months old', () => {
    expect(grounded({ dateQuote: 'Fair on May 15', startDate: '2027-05-15', weekdays: null }, sources('S4'), NOW)).toBe(false);
    // A recent source beside it is enough.
    const [recent] = sources('S1');
    if (recent === undefined) throw new Error('S1');
    const withRecent = [...sources('S4'), { ...recent, quotes: ['Fair on May 15'] }];
    expect(grounded({ dateQuote: 'Fair on May 15', startDate: '2027-05-15', weekdays: null }, withRecent, NOW)).toBe(true);
  });

  it('rates by code: high on 2 hosts, medium on 1, low ungrounded', () => {
    expect(codeConfidence(true, sources('S1', 'S2'))).toBe('high');
    expect(codeConfidence(true, sources('S1'))).toBe('medium');
    expect(codeConfidence(false, sources('S1', 'S2'))).toBe('low');
  });

  it('keeps the lower of two ratings', () => {
    expect(lowerOf('high', 'medium')).toBe('medium');
    expect(lowerOf('low', 'high')).toBe('low');
    expect(lowerOf('high', 'high')).toBe('high');
  });
});

describe('verifyExtract', () => {
  it('keeps a grounded event with its ledger URLs, rated the lower of code and model', () => {
    const { events, drops } = verify([event({ sourceIds: ['S1', 'S2', 'S1'], confidence: 'medium' })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Town Fair', start: '2027-05-15', end: '2027-05-15', startTime: '10:00', grounded: true, codeConfidence: 'high', confidence: 'medium',
      sources: [{ label: 'Sentinel-title 1', url: FAIR }, { label: 'Sentinel-title 2', url: NEWS }],
    });
    expect(Object.values(drops).every((n) => n === 0)).toBe(true);
  });

  it('stores an ungrounded event low whatever the model said', () => {
    const { events } = verify([event({ dateQuote: 'May 15 is the fair', confidence: 'high' })]);
    expect(events[0]).toMatchObject({ grounded: false, codeConfidence: 'low', confidence: 'low' });
  });

  it('counts each drop reason', () => {
    const { events, drops } = verify([
      event({ sourceIds: [] }),
      event({ sourceIds: ['S9'] }),
      event({ sourceIds: ['S1', 'S9'] }),
      event({ startDate: '2027-02-30', endDate: '2027-02-30' }),
      event({ startDate: '2027-05-16', endDate: '2027-05-15' }),
      event({ startDate: '2027-06-01', endDate: '2027-06-01' }),
      event({ startDate: '2026-11-01', endDate: '2026-11-01' }),
      event({ startDate: '2027-01-01', endDate: '2027-02-15' }),
      event({ kind: 'season', startDate: '2026-12-01', endDate: '2027-08-01' }),
      event({ startDate: '2027-05-15', endDate: '2027-05-16', weekdays: [3] }),
      event({ weekdays: [] }),
      event({ title: 'Trivia night, call 603-555-0100' }),
      event({ competitor: 3 }),
      event({ kind: 'party' }),
      'not an object',
    ]);
    expect(events).toEqual([]);
    expect(drops).toEqual({
      bad_shape: 2, over_cap: 0, no_source: 1, unknown_source: 2, bad_dates: 8, bad_title: 1, bad_competitor: 1,
    });
  });

  it('keeps a start within 7 days outside the window, a 200-day season and an in-range competitor', () => {
    const { events } = verify([
      event({ startDate: '2026-11-13', endDate: '2026-11-20' }),
      event({ kind: 'season', startDate: '2026-12-01', endDate: '2027-06-18' }),
      event({ competitor: 2 }),
    ], [], { competitors: [1, 2] });
    expect(events.map((found) => [found.start, found.competitor])).toEqual([['2026-11-13', null], ['2026-12-01', null], ['2027-05-15', 2]]);
  });

  it('caps events at 40 and entities at 30, counting the rest', () => {
    const { events, entities, drops, entityDrops } = verify(
      Array.from({ length: 42 }, () => event()),
      Array.from({ length: 31 }, (_, i) => entity({ ref: `e${String(i)}` })),
    );
    expect(events).toHaveLength(40);
    expect(drops.over_cap).toBe(2);
    expect(entities).toHaveLength(30);
    expect(entityDrops.over_cap).toBe(1);
  });

  it('drops an entity whose name fails safeText and keeps its event with no venue', () => {
    const { events, entities, entityDrops } = verify(
      [event({ venueRef: 'e1', hostRef: 'e2' })],
      [entity({ name: 'Book at example.com' }), entity({ ref: 'e2', type: 'organization', name: 'Town Fair Committee' })],
    );
    expect(entities.map((kept) => kept.ref)).toEqual(['e2']);
    expect(entityDrops.bad_name).toBe(1);
    expect(events[0]).toMatchObject({ venueRef: null, hostRef: 'e2' });
  });

  it('clears an unknown venue or host ref and keeps the event', () => {
    const { events } = verify([event({ venueRef: 'nope', hostRef: 'e1' })], [entity()]);
    expect(events[0]).toMatchObject({ venueRef: null, hostRef: 'e1' });
  });

  it('drops entities with a repeated ref or no known source', () => {
    const { entities, entityDrops } = verify([], [entity(), entity({ name: 'Other' }), entity({ ref: 'e3', sourceIds: ['S9'] }), { ref: 'e4' }]);
    expect(entities.map((kept) => kept.name)).toEqual(['Town Green']);
    expect(entityDrops).toEqual({ bad_shape: 1, over_cap: 0, bad_ref: 1, bad_name: 0, no_source: 1 });
  });

  it('labels a source by its host when its title fails safeText', () => {
    const bad = buildLedger([message([{
      type: 'web_search_tool_result', tool_use_id: 's1', caller: { type: 'direct' },
      content: [{ type: 'web_search_result', title: 'Tickets at fair.example.com', url: FAIR, encrypted_content: 'x', page_age: null }],
    }, citedQuotes('EVENT: fair.', [{ url: FAIR, quote: 'Saturday, May 15' }])])]);
    const { events } = verify([event()], [], { ledger: bad });
    expect(events[0]?.sources).toEqual([{ label: 'example.com', url: FAIR }]);
  });

  it('reads a recurrence by weekdays and clears a bad start time', () => {
    const { events } = verify([event({
      title: 'Farmers market', kind: 'season', category: 'market', startDate: '2026-11-25', endDate: '2027-03-31', weekdays: [3, 3],
      startTime: '3 pm', sourceIds: ['S3'], dateQuote: 'every Wednesday, 3 to 6 pm', confidence: 'high',
    })]);
    expect(events[0]).toMatchObject({ weekdays: [3], startTime: null, grounded: true, confidence: 'medium' });
  });

  it('answers null for an answer that is not the schema\'s object', () => {
    expect(verifyExtract('nope', context())).toBeNull();
    expect(verifyExtract({ events: [] }, context())).toBeNull();
  });
});

describe('EXTRACT_FORMAT', () => {
  it('asks for no effect and names every field', () => {
    const schema = JSON.stringify(EXTRACT_FORMAT.schema);
    expect(schema).not.toMatch(/effect/i);
    for (const field of ['title', 'kind', 'category', 'startDate', 'endDate', 'weekdays', 'startTime', 'status', 'venueRef', 'hostRef', 'competitor', 'sourceIds', 'dateQuote', 'confidence', 'ref', 'name']) {
      expect(schema).toContain(`"${field}"`);
    }
  });
});
