// A run's merge plan (D66 design decision 8, task 1.7): dedupe across threads, curated and town duplicates, the
// curated term days, found-again updates that never touch a title or dates, the status and confidence rules, entities
// by name key, competitor links with and without a place index, and a replayed plan that changes nothing. The curated
// rows are Hanover's real ones (town-calendar.ts); every researched title, host and URL is made up.
import { describe, expect, it } from 'vitest';

import { jaccard, nameKey, sameBusiness, sameEvent, titleKey, titleTokens } from '../src/research/dedupe.ts';
import { planMerge, type MergeInput, type StoredEntity, type StoredEvent, type ThreadFound } from '../src/research/merge.ts';
import type { ThreadId } from '../src/research/threads.ts';
import type { Finding, FoundEntity, SourceRef } from '../src/research/verify.ts';
import { townEvents } from '../src/town-calendar.ts';

const RUN = 'run-2';
const curated = townEvents('hanover-nh', { from: '2026-11-19', to: '2027-05-18' });

function src(name: string): SourceRef {
  return { label: `${name}.example.org`, url: `https://${name}.example.org/` };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    title: 'Sentinel Ice Sculpture Show', kind: 'event', category: 'festival', start: '2027-02-20', end: '2027-02-21', weekdays: null,
    startTime: null, status: 'scheduled', venueRef: null, hostRef: null, competitor: null, sources: [src('a')], grounded: true,
    codeConfidence: 'medium', confidence: 'medium', ...over,
  };
}

function thread(id: ThreadId, events: Finding[], entities: FoundEntity[] = []): ThreadFound {
  return { thread: id, events, entities };
}

function stored(over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'e1', title: 'Sentinel Ice Sculpture Show', start: '2027-02-20', end: '2027-02-21', category: 'festival', status: 'scheduled',
    confidence: 'medium', sources: [src('old')], seenCount: 3, lastRunId: 'run-1', venueKey: null, ...over,
  };
}

function input(over: Partial<MergeInput>): MergeInput {
  return { runId: RUN, subject: 'town', found: [], stored: [], storedEntities: [], curated: [], townRows: [], competitorPlaces: null, ownNames: [], ...over };
}

describe('dedupe keys', () => {
  it('reads names by one key: no leading "the", no company suffix, no accents or case', () => {
    expect(nameKey('The Hopkins Center')).toBe(nameKey('Hopkins Center'));
    expect(nameKey('Sentinel Brewing Co., Inc.')).toBe('sentinel brewing');
    expect(nameKey('Café Évora')).toBe('cafe evora');
    expect(nameKey('The')).toBe('the');
    expect(nameKey('  ')).toBe('');
  });

  it('compares titles by their meaningful words', () => {
    expect([...titleTokens('The Dartmouth\'s Winter Carnival & Ball')]).toEqual(['dartmouth', 'winter', 'carnival', 'ball']);
    expect(titleKey('The Ice Show on the Green')).toBe('ice show green');
    expect(jaccard(titleTokens('Winter Carnival'), titleTokens('Dartmouth Winter Carnival'))).toBeCloseTo(2 / 3);
  });

  it('holds two happenings the same by close dates and title, or by venue, start and category', () => {
    const base = { title: 'Ice Sculpture Show', start: '2027-02-20', end: '2027-02-20', category: 'festival', venueKey: null };
    expect(sameEvent(base, { ...base, title: 'Sentinel Ice Sculpture Show', start: '2027-02-21', end: '2027-02-21' })).toBe(true);
    expect(sameEvent(base, { ...base, start: '2027-02-23', end: '2027-02-23' })).toBe(false);
    expect(sameEvent({ ...base, venueKey: 'green' }, { ...base, title: 'Snow sculptures', venueKey: 'green' })).toBe(true);
    expect(sameEvent({ ...base, venueKey: 'green' }, { ...base, title: 'Snow sculptures', venueKey: 'green', category: 'arts' })).toBe(false);
  });
});

describe('planMerge', () => {
  it('dedupes across threads: the higher confidence wins and the sources are unioned', () => {
    const plan = planMerge(input({
      found: [
        thread('arts_festivals', [finding({ title: 'Ice Sculpture Show', sources: [src('a')], confidence: 'medium' })]),
        thread('tourism_seasonal', [finding({ title: 'Sentinel Ice Sculpture Show', start: '2027-02-21', sources: [src('b')], confidence: 'high', codeConfidence: 'high' })]),
      ],
    }));
    expect(plan.found).toBe(2);
    expect(plan.drops.duplicate).toBe(1);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({ title: 'Sentinel Ice Sculpture Show', start: '2027-02-21', confidence: 'high', thread: 'tourism_seasonal' });
    expect(plan.inserts[0]?.sources.map((source) => source.url)).toEqual([src('b').url, src('a').url]);
  });

  it('drops a finding that repeats a curated row', () => {
    const carnival = curated.find((row) => row.title === 'Winter Carnival');
    if (carnival === undefined) throw new Error('no curated Winter Carnival');
    const plan = planMerge(input({
      curated,
      found: [thread('arts_festivals', [finding({ title: 'Dartmouth Winter Carnival', start: carnival.start, end: carnival.end }), finding()])],
    }));
    expect(plan.drops.curated_dupe).toBe(1);
    expect(plan.inserts.map((row) => row.title)).toEqual(['Sentinel Ice Sculpture Show']);
  });

  it('drops a schools finding on a curated term\'s first or last day, and keeps another thread\'s', () => {
    const term = curated.find((row) => row.kind === 'term' && row.title === 'Winter term finals');
    if (term === undefined) throw new Error('no curated term');
    const onTermDay = { title: 'Reading period ends', category: 'school' as const, start: term.end, end: term.end };
    const plan = planMerge(input({
      curated,
      found: [thread('schools', [finding(onTermDay)]), thread('civic', [finding({ ...onTermDay, title: 'Sentinel road paving', category: 'civic' })])],
    }));
    expect(plan.drops.curated_dupe).toBe(1);
    expect(plan.inserts.map((row) => row.title)).toEqual(['Sentinel road paving']);
  });

  // Live eval 2026-11-19: the tourism thread stored "Dartmouth Fall Term Final Examinations" over the curated "Fall term
  // finals" (Nov 20 to 25), since the term-day rule read only the schools thread and the titles share 2 of 6 words.
  it('drops a school finding of any thread on a curated term\'s first or last day', () => {
    const term = curated.find((row) => row.kind === 'term' && row.title === 'Winter term finals');
    if (term === undefined) throw new Error('no curated term');
    const plan = planMerge(input({
      curated,
      found: [thread('tourism_seasonal', [finding({ title: 'Dartmouth Winter Term Final Examinations', category: 'school', start: term.start, end: term.end })])],
    }));
    expect(plan.drops.curated_dupe).toBe(1);
    expect(plan.inserts).toEqual([]);
  });

  it('drops a location finding that repeats one of its town\'s stored rows; a town run has none to repeat', () => {
    const townRows = [stored({ id: 'town-row' })];
    const found = [thread('neighborhood', [finding()])];
    const located = planMerge(input({ subject: 'location', townRows, found }));
    expect(located.drops.town_dupe).toBe(1);
    expect(located.inserts).toEqual([]);
    expect(planMerge(input({ subject: 'town', townRows, found: [thread('arts_festivals', [finding()])] })).inserts).toHaveLength(1);
  });

  it('a stored row found again keeps its id, title and dates, gains the source, and its runs seen go up by one', () => {
    const plan = planMerge(input({
      stored: [stored()],
      found: [thread('arts_festivals', [finding({ title: 'Sentinel Ice Sculpture Show on the Green', start: '2027-02-21', end: '2027-02-22', sources: [src('new')] })])],
    }));
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([{
      id: 'e1', lastRunId: RUN, seenCount: 4, sources: [src('old'), src('new')], confidence: 'medium', status: 'scheduled',
    }]);
  });

  it('counts a run once when two of its findings match one row', () => {
    // Two days of a week-long row: too far apart to be one finding, both inside the row.
    const plan = planMerge(input({
      stored: [stored({ end: '2027-02-28' })],
      found: [
        thread('arts_festivals', [finding({ end: '2027-02-20', sources: [src('b')] })]),
        thread('markets_community', [finding({ start: '2027-02-25', end: '2027-02-25', sources: [src('c')] })]),
      ],
    }));
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ seenCount: 4, sources: [src('old'), src('b'), src('c')] });
  });

  it('a merge redone after its update was written counts the run no second time', () => {
    const plan = planMerge(input({
      stored: [stored({ lastRunId: RUN, seenCount: 4 })],
      found: [thread('arts_festivals', [finding({ sources: [src('new')] })])],
    }));
    expect(plan.updates).toEqual([{ id: 'e1', lastRunId: RUN, seenCount: 4, sources: [src('old'), src('new')], confidence: 'medium', status: 'scheduled' }]);
  });

  it('cancels a stored row on a grounded medium finding at least as strong as the row', () => {
    const plan = planMerge(input({
      stored: [stored({ confidence: 'medium' })],
      found: [thread('arts_festivals', [finding({ status: 'cancelled', codeConfidence: 'medium', confidence: 'medium' })])],
    }));
    expect(plan.updates[0]?.status).toBe('cancelled');
  });

  it('a low cancellation, or one weaker than the row, leaves a high row scheduled', () => {
    for (const weak of [{ codeConfidence: 'low', confidence: 'low' }, { codeConfidence: 'medium', confidence: 'medium' }] as const) {
      const plan = planMerge(input({
        stored: [stored({ confidence: 'high' })],
        found: [thread('arts_festivals', [finding({ status: 'cancelled', ...weak })])],
      }));
      expect(plan.updates[0]?.status).toBe('scheduled');
    }
  });

  it('an ungrounded cancellation leaves even a low row scheduled: code confidence must reach medium', () => {
    const plan = planMerge(input({
      stored: [stored({ confidence: 'low' })],
      found: [thread('arts_festivals', [finding({ status: 'cancelled', codeConfidence: 'low', confidence: 'low', grounded: false })])],
    }));
    expect(plan.updates[0]?.status).toBe('scheduled');
  });

  it('only ever raises confidence', () => {
    const lower = planMerge(input({ stored: [stored({ confidence: 'high' })], found: [thread('arts_festivals', [finding({ confidence: 'low', codeConfidence: 'low' })])] }));
    expect(lower.updates[0]?.confidence).toBe('high');
    const higher = planMerge(input({ stored: [stored({ confidence: 'low' })], found: [thread('arts_festivals', [finding({ confidence: 'high', codeConfidence: 'high' })])] }));
    expect(higher.updates[0]?.confidence).toBe('high');
  });

  it('consolidates entities by name key across threads, with a stored entity\'s id, and links both events to it', () => {
    const storedEntities: StoredEntity[] = [{ id: 'ent-9', type: 'venue', nameKey: 'hopkins center' }];
    const plan = planMerge(input({
      storedEntities,
      found: [
        thread('arts_festivals', [finding({ title: 'Sentinel string quartet', venueRef: 'v1' })], [{ ref: 'v1', type: 'venue', name: 'The Hopkins Center', sources: [src('a')] }]),
        thread('markets_community', [finding({ title: 'Sentinel holiday craft fair', start: '2027-03-06', end: '2027-03-06', venueRef: 'hop' })], [
          { ref: 'hop', type: 'venue', name: 'Hopkins Center', sources: [src('b')] },
        ]),
      ],
    }));
    expect(plan.entities).toEqual([{ key: { type: 'venue', nameKey: 'hopkins center' }, name: 'The Hopkins Center', sources: [src('a'), src('b')], id: 'ent-9' }]);
    expect(plan.inserts.map((row) => row.venue)).toEqual([{ type: 'venue', nameKey: 'hopkins center' }, { type: 'venue', nameKey: 'hopkins center' }]);
  });

  it('dedupes two titles for one happening at the same venue, start and category', () => {
    const venue = (ref: string): FoundEntity => ({ ref, type: 'venue', name: 'Sentinel Green', sources: [src('a')] });
    const plan = planMerge(input({
      found: [
        thread('arts_festivals', [finding({ title: 'Snow sculptures', venueRef: 'g' })], [venue('g')]),
        thread('tourism_seasonal', [finding({ title: 'Ice art weekend', venueRef: 'x', end: '2027-02-20' })], [venue('x')]),
      ],
    }));
    expect(plan.drops.duplicate).toBe(1);
    expect(plan.inserts).toHaveLength(1);
  });

  it('links a competitor\'s event to its business entity, and to its place only with a place index', () => {
    const tavern: FoundEntity = { ref: 'b1', type: 'business', name: 'Sentinel Tavern LLC', sources: [src('t')] };
    const found = [thread('competitors', [finding({ title: 'Sentinel trivia night', hostRef: 'b1', competitor: 2 })], [tavern])];
    const withPlaces = planMerge(input({ subject: 'location', found, competitorPlaces: new Map([[2, 'ChIJsentinel2']]) }));
    expect(withPlaces.inserts[0]).toMatchObject({
      origin: 'competitor', competitorEntity: { type: 'business', nameKey: 'sentinel tavern' }, competitorPlaceId: 'ChIJsentinel2',
    });
    const webOnly = planMerge(input({ subject: 'location', found, competitorPlaces: null }));
    expect(webOnly.inserts[0]).toMatchObject({ competitorEntity: { type: 'business', nameKey: 'sentinel tavern' }, competitorPlaceId: null });
    const outOfRange = planMerge(input({ subject: 'location', found, competitorPlaces: new Map([[1, 'ChIJsentinel1']]) }));
    expect(outOfRange.inserts[0]?.competitorPlaceId).toBeNull();
    // A neighborhood event hosted by a business is no competitor's.
    const neighbor = planMerge(input({ subject: 'location', found: [thread('neighborhood', [finding({ hostRef: 'b1' })], [tavern])] }));
    expect(neighbor.inserts[0]).toMatchObject({ origin: 'neighborhood', competitorEntity: null, competitorPlaceId: null });
  });

  it('files an event the competitors thread found at the restaurant itself as its own, not a competitor\'s', () => {
    const own: FoundEntity = { ref: 'b1', type: 'business', name: 'Sentinel Kitchen, Bar and Stage', sources: [src('k')] };
    const tavern: FoundEntity = { ref: 'b2', type: 'business', name: 'Sentinel Tavern', sources: [src('t')] };
    const found = [thread('competitors', [
      finding({ title: 'The Lantern Fits live', hostRef: 'b1', venueRef: 'b1', competitor: 1 }),
      finding({ title: 'Sentinel trivia night', start: '2027-03-04', end: '2027-03-04', hostRef: 'b2', competitor: 2 }),
    ], [own, tavern])];
    // By the typed name's first words, and by Google's full name.
    for (const ownNames of [[nameKey('Sentinel Kitchen')], [nameKey('Main Room'), nameKey('Sentinel Kitchen, Bar & Stage')]]) {
      const plan = planMerge(input({ subject: 'location', found, ownNames, competitorPlaces: new Map([[1, 'ChIJown'], [2, 'ChIJsentinel2']]) }));
      expect(plan.inserts.map((row) => [row.title, row.origin, row.competitorEntity?.nameKey ?? null, row.competitorPlaceId])).toEqual([
        ['The Lantern Fits live', 'neighborhood', null, null],
        ['Sentinel trivia night', 'competitor', 'sentinel tavern', 'ChIJsentinel2'],
      ]);
    }
    // A name it does not share is a competitor still.
    const other = planMerge(input({ subject: 'location', found, ownNames: [nameKey('Riverbank Cafe')] }));
    expect(other.inserts.map((row) => row.origin)).toEqual(['competitor', 'competitor']);
  });

  it('holds two business names the same only when equal or when the shorter is the longer\'s first words and not too short', () => {
    expect(sameBusiness('sentinel kitchen', 'sentinel kitchen bar and stage')).toBe(true);
    expect(sameBusiness('sentinel', 'sentinel kitchen')).toBe(true);
    expect(sameBusiness('inn', 'inn at mill falls')).toBe(false);
    expect(sameBusiness('sentinel', 'sentinels tavern')).toBe(false);
    expect(sameBusiness('', '')).toBe(false);
  });

  it('stamps no origin on a town run\'s rows', () => {
    expect(planMerge(input({ found: [thread('civic', [finding()])] })).inserts[0]?.origin).toBeNull();
  });

  it('a replayed plan over its own inserts adds and changes nothing', () => {
    const tavern: FoundEntity = { ref: 'b1', type: 'business', name: 'Sentinel Tavern', sources: [src('t')] };
    const merge = (stored: StoredEvent[], storedEntities: StoredEntity[]): ReturnType<typeof planMerge> => planMerge(input({
      subject: 'location', stored, storedEntities,
      found: [
        thread('neighborhood', [finding(), finding({ title: 'Sentinel jazz brunch', start: '2027-03-07', end: '2027-03-07' })]),
        thread('competitors', [finding({ title: 'Sentinel trivia night', start: '2027-01-13', end: '2027-01-13', hostRef: 'b1' })], [tavern]),
      ],
    }));
    const first = merge([], []);
    expect(first.inserts).toHaveLength(3);
    const written: StoredEvent[] = first.inserts.map((row, index) => ({
      id: `e${String(index)}`, title: row.title, start: row.start, end: row.end, category: row.category, status: row.status,
      confidence: row.confidence, sources: row.sources, seenCount: 1, lastRunId: RUN, venueKey: row.venue?.nameKey ?? null,
    }));
    const entities: StoredEntity[] = first.entities.map((entity, index) => ({ id: `n${String(index)}`, ...entity.key }));
    const again = merge(written, entities);
    expect(again.inserts).toEqual([]);
    expect(again.updates).toEqual([]);
    expect(again.entities.map((entity) => entity.id)).toEqual(['n0']);
  });
});
