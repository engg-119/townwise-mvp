import * as copy from '../../../src/portal/town/research-copy';
import {
  businessDay, competitorLine, distanceWords, entityLine, eventChips, eventWhen, finishedNotice, gapLine, hiddenHeading,
  moreLine, nextLine, placeType, pressOpensLine, pressRefusal, runLine, switchLabel, switchState, switchWords, topicLabel, topicState, townHolds,
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
    // Topics skipped for budget were not tried: said so, not that they didn't finish (UI review).
    const skipped = [
      { thread: 'neighborhood', status: 'recorded', code: null }, { thread: 'competitors', status: 'budget', code: null },
      { thread: 'town_overview', status: 'budget', code: null },
    ];
    expect(runLine({ kind: 'location' }, run('partial', skipped))).toMatch(/3 new\. Some topics were skipped, little budget left this month\.$/);
    const mixed = [skipped[0], skipped[1], { thread: 'town_overview', status: 'failed', code: 'internal' }].flatMap((each) => (each === undefined ? [] : [each]));
    expect(runLine({ kind: 'location' }, run('partial', mixed))).toMatch(/Some topics didn’t finish\.$/);
  });

  test('queued, merging, failed, budget, off and none', () => {
    const town = { kind: 'town', name: 'Hanover' } as const;
    // Capitalized as its topics' "Queued" (UI review).
    expect(runLine(town, run('queued', [], null))).toBe('Hanover: Queued');
    expect(runLine({ kind: 'location' }, run('queued', [], null))).toBe('Your restaurant and nearby: Queued');
    expect(runLine(town, run('merging', [], null))).toBe('Researching Hanover: adding what it found to the calendar');
    expect(runLine(town, run('failed'))).toBe(`Hanover: research on ${copy.shortDay(FINISHED)} didn’t finish`);
    expect(runLine(town, run('budget', [], null))).toBe('Hanover: research was skipped, little budget left this month');
    expect(runLine(town, run('off', [], null))).toBe('Hanover: research stopped before it finished');
    expect(runLine({ kind: 'location' }, null)).toBe('Your restaurant and nearby: not researched yet');
  });

  test('a live run reads paused while research is off, and an ended one as it ended (UI review)', () => {
    const threads = [{ thread: 'neighborhood', status: 'recorded', code: null }, { thread: 'competitors', status: 'recorded', code: null }];
    expect(runLine({ kind: 'location' }, run('running', threads, null), true)).toBe('Your restaurant and nearby: paused, 2 of 2 topics done');
    expect(runLine({ kind: 'town', name: 'Hanover' }, run('queued', [], null), true)).toBe('Hanover: paused');
    expect(runLine({ kind: 'location' }, run('done'), true)).toBe(runLine({ kind: 'location' }, run('done')));
  });

  test('a running location run whose topics are all done says it waits for the town’s research (UI review)', () => {
    const done = [{ thread: 'neighborhood', status: 'recorded', code: null }, { thread: 'competitors', status: 'empty', code: null }];
    expect(runLine({ kind: 'location' }, run('running', done, null), false, 'Hanover'))
      .toBe('Your restaurant and nearby: 2 of 2 topics done, waiting for Hanover’s research to finish');
    // Not while a topic is still going, nor with no town run holding it.
    const going = [done[0], { thread: 'competitors', status: 'running', code: null }].flatMap((each) => (each === undefined ? [] : [each]));
    expect(runLine({ kind: 'location' }, run('running', going, null), false, 'Hanover')).toBe('Researching your restaurant and nearby: 1 of 2 topics done');
    expect(runLine({ kind: 'location' }, run('running', done, null))).toBe('Researching your restaurant and nearby: 2 of 2 topics done');
    // Paused wins: nothing goes on while research is off.
    expect(runLine({ kind: 'location' }, run('running', done, null), true, 'Hanover')).toBe('Your restaurant and nearby: paused, 2 of 2 topics done');
    // Only a running or merging town run holds the location's merge; a queued one does not.
    expect([townHolds(run('running')), townHolds(run('merging')), townHolds(run('queued')), townHolds(run('done')), townHolds(null)])
      .toEqual([true, true, false, false, false]);
  });

  test('Research now\'s help says the 6 hours after a finish and the 3 a day (UI review)', () => {
    expect(copy.RESEARCH_NOW_HELP).toBe('Looks again at your restaurant, its neighborhood and its competitors. You can press it 6 hours after research last finished, up to 3 times a day.');
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
    // No place picked: the neighborhood and competitors topics end empty (design decision 4), not only the map.
    expect(gapLine('no_place', opts)).toMatch(/so research skips your restaurant and its competitors/);
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

  test('within 6 hours of the last run, Research now says when it opens again, with the day when it is not today', () => {
    const now = new Date(2026, 10, 19, 10, 0);
    expect(pressOpensLine(new Date(2026, 10, 19, 15, 40).toISOString(), now))
      .toBe('Research ran in the last 6 hours. You can press Research now again at 3:40 pm.');
    expect(pressOpensLine(new Date(2026, 10, 20, 3, 0).toISOString(), now))
      .toBe('Research ran in the last 6 hours. You can press Research now again on Nov 20 at 3 am.');
    expect(pressOpensLine('not a time', now)).toBe('Research ran in the last 6 hours. Try again later.');
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
    switchWords('Hanover'), pressOpensLine('2026-11-19T15:40:00.000Z', new Date('2026-11-19T10:00:00.000Z')), runLine({ kind: 'town', name: 'Hanover' }, run('running', [{ thread: 'sports', status: 'running', code: null }], null)),
    ...(['off', 'no_place', 'not_researched_town', 'budget', 'places_off'] as const).map((gap) => gapLine(gap, { town: 'Hanover', admin: true, on: true, available: true })),
  );
  expect(strings.length).toBeGreaterThan(30);
  for (const text of strings) {
    expect(text).not.toMatch(/thread/i);
    expect(text).not.toContain('—');
  }
});

describe('Google Maps credit (Places policies)', () => {
  test('"Google Maps" never wraps and is in a color Google allows', () => {
    expect(copy.GOOGLE_MAPS).toBe('Google Maps');
    expect(copy.googleMapsCreditColor('light')).toBe('#5E5E5E');
    expect(copy.googleMapsCreditColor('dark')).toBe('#FFFFFF');
    expect(copy.COMPETITION_SOURCE).toBe(`${copy.COMPETITION_SOURCE_BEFORE}${copy.GOOGLE_MAPS}${copy.COMPETITION_SOURCE_AFTER}`);
  });
});
