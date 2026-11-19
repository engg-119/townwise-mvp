import * as copy from '../../../src/portal/town/research-copy';
import {
  businessDay, competitorLine, distanceWords, entityLine, eventChips, eventWhen, finishedNotice, gapLine, hiddenHeading,
  moreLine, nextLine, placeType, pressRefusal, runLine, switchLabel, switchState, switchWords, topicLabel, topicState,
} from '../../../src/portal/town/research-copy';
import type { TownRun } from '../../../src/portal/research/api';

// The Town tab's research words (D66 design decision 15, task 7.5): topics never threads, plain words, no em dash.

const COUNTS = { found: 9, added: 3, updated: 1, dropped: 2 };
const FINISHED = '2026-11-17T15:00:00.000Z';

function run(status: TownRun['status'], threads: TownRun['threads'] = [], finishedAt: string | null = FINISHED): TownRun {
  return { status, finishedAt, threads, counts: COUNTS };
}

const SIX = ['schools', 'sports', 'arts_festivals', 'civic', 'tourism_seasonal', 'markets_community'];

describe('status in topics', () => {
  test('a running town run counts its topics done', () => {
    const threads = SIX.map((thread, i) => ({ thread, status: i < 3 ? 'recorded' : 'running', code: null }));
    expect(runLine({ kind: 'town', name: 'Hanover' }, run('running', threads, null))).toBe('Researching Hanover: 3 of 6 topics done');
  });

  test('a finished location run says when, how many events and how many new', () => {
    expect(runLine({ kind: 'location' }, run('done'))).toBe(`Your restaurant and nearby: last researched ${copy.shortDay(FINISHED)}, 9 events, 3 new`);
    expect(runLine({ kind: 'location' }, run('partial'))).toMatch(/3 new\. Some topics didn’t finish\.$/);
  });

  test('queued, merging, failed, budget, off and none', () => {
    const town = { kind: 'town', name: 'Hanover' } as const;
    expect(runLine(town, run('queued', [], null))).toBe('Hanover: queued');
    expect(runLine(town, run('merging', [], null))).toBe('Researching Hanover: adding what it found to the calendar');
    expect(runLine(town, run('failed'))).toBe(`Hanover: research on ${copy.shortDay(FINISHED)} didn’t finish`);
    expect(runLine(town, run('budget', [], null))).toBe('Hanover: research was skipped, little budget left this month');
    expect(runLine(town, run('off', [], null))).toBe('Hanover: research stopped before it finished');
    expect(runLine({ kind: 'location' }, null)).toBe('Your restaurant and nearby: not researched yet');
  });

  test('each topic in words, a queued one with a code waiting to try again', () => {
    expect(SIX.map(topicLabel)).toEqual([
      'Schools and college', 'Sports', 'Arts and festivals', 'Town meetings, road work and parking', 'Tourism and seasons', 'Markets and community',
    ]);
    expect(['neighborhood', 'competitors', 'town_overview', 'new_thing'].map(topicLabel)).toEqual([
      'Your restaurant and its neighborhood', 'Competitors and their events', 'Your town', 'Another topic',
    ]);
    expect(topicState({ status: 'queued', code: null })).toBe('Queued');
    expect(topicState({ status: 'queued', code: 'overloaded' })).toBe('Waiting to try again');
    expect(['running', 'recorded', 'empty', 'budget', 'failed'].map((status) => topicState({ status, code: null }))).toEqual([
      'Researching', 'Done', 'Done, nothing found', 'Skipped, little budget left this month', 'Didn’t finish',
    ]);
  });

  test('the next run and the dates', () => {
    expect(nextLine('2026-11-23')).toBe('Next weekly research: Mon, Nov 23');
    expect(nextLine(null)).toBeNull();
    expect(businessDay('2026-12-03')).toBe('Thu, Dec 3');
  });
});

describe('gaps', () => {
  const opts = { town: 'Lebanon', admin: true, on: true, available: true };
  test('each gap in words, for admins and members', () => {
    expect(gapLine('off', { ...opts, on: false })).toBe('Town research is off for your organization, so nothing new is being found.');
    expect(gapLine('off', { ...opts, available: false })).toBe('Town research isn’t running here right now, so nothing new is being found.');
    expect(gapLine('no_place', opts)).toMatch(/Link it in Location settings\.$/);
    expect(gapLine('no_place', { ...opts, admin: false })).toMatch(/An admin can link it in Location settings\.$/);
    expect(gapLine('not_researched_town', opts)).toBe('Lebanon isn’t one of the towns Townwise researches each week, so this restaurant’s research covers the town too.');
    expect(gapLine('budget', opts)).toMatch(/or press Research now\.$/);
    expect(gapLine('budget', { ...opts, admin: false })).not.toMatch(/Research now/);
    expect(gapLine('places_off', opts)).toBe('Google Maps wasn’t available, so some research about your restaurant was skipped.');
  });
});

describe('Research now and the switch', () => {
  test('refusals in words; anything else falls back to the shared copy', () => {
    expect(pressRefusal(409, 'research_running')).toBe('Research is already running for this location.');
    expect(pressRefusal(409, 'too_soon')).toBe('Research ran in the last 6 hours. Try again later.');
    expect(pressRefusal(503, 'research_off')).toBe('Town research is off, so it can’t run now.');
    expect(pressRefusal(429, 'rate_limited')).toBe('You can press Research now 3 times a day. Try again tomorrow.');
    expect(pressRefusal(500, null)).toBeNull();
  });

  test('a finished run says what it found', () => {
    expect(finishedNotice(run('done'))).toBe('Research finished: 3 new events on your calendar.');
    expect(finishedNotice({ status: 'done', counts: { ...COUNTS, added: 0 } })).toBe('Research finished. Nothing new this time.');
    expect(finishedNotice(run('failed'))).toBe('Research didn’t finish. The lines above say why.');
    expect(finishedNotice(run('running'))).toBeNull();
  });

  test('the switch says what research sends and never sends', () => {
    const words = switchWords('Hanover');
    expect(words).toMatch(/events in Hanover/);
    expect(words).toMatch(/It sends Anthropic your town and this restaurant’s name, never your sales, notes, calendars, or anyone’s name or email\./);
    expect(switchState(true, true)).toBe('Town research is on.');
    expect(switchState(true, false)).toBe('Town research is on, but it isn’t running here right now.');
    expect(switchState(false, true)).toBe('Town research is off.');
    expect([switchLabel(true), switchLabel(false)]).toEqual(['Turn off town research', 'Turn on town research']);
  });
});

describe('lists and the Competition card', () => {
  const event = { start: '2026-12-03', end: '2026-12-03', startTime: '19:00', confidence: 'low', status: 'cancelled' } as const;
  test('an event’s dates, time and chips', () => {
    expect(eventWhen(event)).toBe('Dec 3, 2026, 7 pm');
    expect(eventWhen({ ...event, end: '2026-12-05', startTime: null })).toBe('Dec 3, 2026 to Dec 5, 2026');
    expect(eventChips(event)).toEqual(['Unconfirmed', 'Cancelled']);
    expect(eventChips({ confidence: 'high', status: 'scheduled' })).toEqual([]);
  });

  test('who and where, hidden, and the week’s overflow', () => {
    expect(entityLine({ type: 'venue', events: 4 })).toBe('Venue · 4 upcoming events');
    expect(entityLine({ type: 'other', events: 1 })).toBe('Place · 1 upcoming event');
    expect(hiddenHeading(2)).toBe('Hidden by your team (2)');
    expect(moreLine(3)).toBe('+3 more on the Calendar');
    expect(moreLine(0)).toBeNull();
  });

  test('a competitor’s type and distance', () => {
    expect(placeType('american_restaurant')).toBe('American restaurant');
    expect(distanceWords(347)).toBe('350 m');
    expect(distanceWords(4)).toBe('10 m');
    expect(distanceWords(1234)).toBe('1.2 km');
    expect(competitorLine({ type: 'bar', distanceM: 120 })).toBe('Bar · 120 m');
  });
});

test('every string says topics, never threads, and has no em dash', () => {
  const strings: string[] = [];
  for (const value of Object.values(copy)) {
    if (typeof value === 'string') strings.push(value);
    else if (typeof value === 'object') strings.push(...Object.values(value as Record<string, string>));
  }
  strings.push(
    switchWords('Hanover'), runLine({ kind: 'town', name: 'Hanover' }, run('running', [{ thread: 'sports', status: 'running', code: null }], null)),
    ...(['off', 'no_place', 'not_researched_town', 'budget', 'places_off'] as const).map((gap) => gapLine(gap, { town: 'Hanover', admin: true, on: true, available: true })),
  );
  expect(strings.length).toBeGreaterThan(30);
  for (const text of strings) {
    expect(text).not.toMatch(/thread/i);
    expect(text).not.toContain('—');
  }
});
