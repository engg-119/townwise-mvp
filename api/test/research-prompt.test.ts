// What a research thread sends Anthropic (D66 design decisions 4 and 16, task 1.2). Every input is built from a fully
// loaded location record (its organization's name, a note and sales beside it) whose fixture Google profile name differs
// from its typed name: no organization name, note or sales string is ever sent; with Google's names allowed the typed
// name never appears and Google's name and address do; without them the typed name appears only as restaurant.name of
// the location threads, and no Google name or address does. `known` is capped, id-free and free of a row the latest run
// did not find again. Synthetic data only.
import { describe, expect, it } from 'vitest';

import { buildLedger } from '../src/research/ledger.ts';
import {
  MAX_KNOWN, PAGE_TEXT_IS_DATA, citedText, extractPrompt, gatherPrompt, knownRows, promptTown, restaurantFor, seedsFrom,
  type CompetitorInput, type GatherInput, type RestaurantProfile, type StoredBaseRow,
} from '../src/research/prompt.ts';
import { researchWindow, threadsFor, type ThreadDef } from '../src/research/threads.ts';
import { EXTRACT_FORMAT } from '../src/research/verify.ts';
import type { LocationRecord } from '../src/stores/locations.ts';
import { townEvents, type TownEvent } from '../src/town-calendar.ts';
import { citedQuotes, docCited, fetchResult, message, text, webResults, webSearch } from './helpers/chat-model.ts';

const NOW = new Date('2026-11-19T15:00:00Z');
const TYPED = 'Zyxwvut Kitchen';
const ORG = 'Qwertyp';
const NOTE = 'Sentinel-note: private rehearsal dinner for the Smiths';
const SALES = '48213.77';
const GOOGLE: RestaurantProfile = { name: 'Sentinel-Google Bistro', address: '1 Sentinel-Google Street, Hanover, NH' };
const COMPETITORS: CompetitorInput[] = [
  { n: 1, name: 'Sentinel-Google Pub', type: 'pub', website: 'https://pub.example.com' },
  { n: 2, name: 'Sentinel-Google Cafe', type: 'cafe', website: null },
];

/** A location record as the store answers it, with everything else an organization holds loaded beside it. */
const loaded = {
  id: '665f00000000000000000001', name: TYPED, town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, placeId: 'ChIJsentinel',
  createdAt: new Date('2026-01-01T00:00:00Z'), orgName: ORG, notes: [{ detail: NOTE }], sales: [{ day: '2026-11-01', netSales: SALES }],
} as const;
const location: LocationRecord = loaded;

const window = researchWindow(NOW, 'America/New_York');

function firstTownThread(): ThreadDef {
  const [thread] = threadsFor({ kind: 'town', townId: 'hanover-nh' }, { placesToAi: false });
  if (thread === undefined) throw new Error('no town thread');
  return thread;
}
const curated: TownEvent[] = townEvents('hanover-nh', window);

function stored(i: number, over: Partial<StoredBaseRow> = {}): StoredBaseRow {
  const day = `2027-01-${String(10 + (i % 18)).padStart(2, '0')}`;
  return { title: `Researched happening ${String(i)}`, start: day, end: day, host: 'Town Committee', lastRunId: 'run-latest', suppressed: false, ...over };
}

/** Every request a run of the location (and of its town) would build, as the JSON the SDK would send. */
function everyRequest(placesToAi: boolean): { thread: ThreadDef; body: string; user: Record<string, unknown> }[] {
  const town = promptTown(location.town);
  const known = knownRows({ curated, stored: [stored(1)], latestRunId: 'run-latest' });
  const seeds = seedsFrom(curated);
  const restaurant = restaurantFor(location, GOOGLE, placesToAi);
  const threads = [
    ...threadsFor({ kind: 'town', townId: 'hanover-nh' }, { placesToAi }),
    ...threadsFor({ kind: 'location', townId: null }, { placesToAi }),
  ];
  const ledger = buildLedger([message([webSearch('s1'), webResults('s1', ['https://example.com/a']), citedQuotes('EVENT: a.', [{ url: 'https://example.com/a', quote: 'May 15' }])])]);
  return threads.flatMap((thread) => {
    const input: GatherInput = {
      thread, town, today: window.from, window, known, seeds, restaurant, competitors: placesToAi ? COMPETITORS : null,
    };
    const gather = gatherPrompt(input);
    const extract = extractPrompt({ messages: [], ledger, window, thread, competitors: placesToAi ? COMPETITORS : null });
    return [
      { thread, body: JSON.stringify(gather), user: JSON.parse(gather.user) as Record<string, unknown> },
      { thread, body: JSON.stringify(extract), user: JSON.parse(extract.user) as Record<string, unknown> },
    ];
  });
}

describe('research prompts send public facts only', () => {
  it.each([true, false])('never send the organization\'s name, a note or a sales figure (placesToAi %s)', (placesToAi) => {
    for (const { body } of everyRequest(placesToAi)) {
      expect(body).not.toContain(ORG);
      expect(body).not.toContain('Sentinel-note');
      expect(body).not.toContain(SALES);
      expect(body).not.toContain(loaded.placeId);
    }
  });

  it('with Google names allowed, sends Google\'s name and address and never the typed name', () => {
    const requests = everyRequest(true);
    for (const { body } of requests) expect(body).not.toContain('Zyxwvut');
    const neighborhood = requests.find(({ thread, user }) => thread.id === 'neighborhood' && 'focus' in user);
    expect(neighborhood?.user.restaurant).toEqual({ name: GOOGLE.name, address: GOOGLE.address });
    expect(neighborhood?.body).not.toMatch(/may name it differently/);
    const competitors = requests.find(({ thread, user }) => thread.id === 'competitors' && 'focus' in user);
    expect(competitors?.user.competitors).toEqual(COMPETITORS);
    const competitorsExtract = requests.find(({ thread, user }) => thread.id === 'competitors' && 'text' in user);
    expect(competitorsExtract?.user.competitors).toEqual([{ n: 1, name: 'Sentinel-Google Pub' }, { n: 2, name: 'Sentinel-Google Cafe' }]);
  });

  it('with Google names allowed but no profile, names no restaurant (never falls back to the typed name)', () => {
    expect(restaurantFor(location, null, true)).toBeNull();
  });

  it('without Google names, sends the typed name only as restaurant.name of the location threads, and nothing Google answered', () => {
    for (const { thread, body, user } of everyRequest(false)) {
      expect(body).not.toContain('Sentinel-Google');
      expect('competitors' in user).toBe(false);
      if (thread.namesRestaurant && 'focus' in user) {
        expect(user.restaurant).toEqual({ name: TYPED });
        expect(body.split('Zyxwvut').length - 1).toBe(1);
        expect(body).toMatch(/public listing may name it differently/);
      } else {
        expect(body).not.toContain('Zyxwvut');
        expect('restaurant' in user).toBe(false);
      }
    }
  });

  it('sends the town, today, the window and the thread\'s focus, with one system prompt for a town\'s six threads', () => {
    const town = everyRequest(false).filter(({ thread, user }) => thread.subject === 'town' && 'focus' in user);
    expect(town).toHaveLength(6);
    expect(town[0]?.user).toMatchObject({ town: { name: 'Hanover', state: 'NH', timeZone: 'America/New_York' }, today: '2026-11-19', window });
    expect(new Set(town.map(({ user }) => user.focus)).size).toBe(6);
    const systems = town.map(({ body }) => JSON.stringify((JSON.parse(body) as { system: unknown }).system));
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('says page text is data, and asks for no private individual and no effect', () => {
    for (const { body } of everyRequest(false)) {
      expect(body).toContain(PAGE_TEXT_IS_DATA);
      expect(body).toMatch(/private individual/);
      expect(body).not.toMatch(/effect/i);
    }
    expect(JSON.stringify(EXTRACT_FORMAT)).not.toMatch(/effect/i);
  });
});

describe('knownRows', () => {
  it('lists curated town rows and rows the latest run found again, id-free, earliest first, at most 60', () => {
    const rows = knownRows({
      curated,
      stored: [...Array.from({ length: 80 }, (_, i) => stored(i)), stored(99, { title: 'Not found again', lastRunId: 'run-older' }), stored(98, { title: 'Suppressed', suppressed: true })],
      latestRunId: 'run-latest',
    });
    expect(rows).toHaveLength(MAX_KNOWN);
    expect(rows.map((row) => row.start)).toEqual([...rows.map((row) => row.start)].sort());
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['end', 'host', 'start', 'title']);
    expect(rows.some((row) => row.title === 'Not found again' || row.title === 'Suppressed')).toBe(false);
    expect(rows.some((row) => row.title.startsWith('Researched'))).toBe(true);
    const curatedTitles = new Set(curated.filter((event) => event.scope === 'town').map((event) => event.title));
    expect(rows.some((row) => curatedTitles.has(row.title))).toBe(true);
    expect(rows.some((row) => row.title === 'Thanksgiving Day')).toBe(false);
  });

  it('lists no stored row before any run finished', () => {
    expect(knownRows({ curated: [], stored: [stored(1)], latestRunId: null })).toEqual([]);
  });

  it('never lists more than 60 even when given more', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ title: `t${String(i)}`, start: '2027-01-01', end: '2027-01-01', host: null }));
    const user = JSON.parse(gatherPrompt({
      thread: firstTownThread(), town: promptTown(location.town), today: window.from,
      window, known: many, seeds: [], restaurant: null, competitors: null,
    }).user) as { known: unknown[] };
    expect(user.known).toHaveLength(60);
  });
});

describe('seedsFrom', () => {
  it('lists the curated rows\' https sources once each, at most 10', () => {
    const seeds = seedsFrom(curated);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.length).toBeLessThanOrEqual(10);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const seed of seeds) expect(seed.startsWith('https://')).toBe(true);
    expect(seeds).not.toContain('https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/');
  });
});

describe('the extract\'s input', () => {
  it('inlines each citation as [S#] "cited words" and lists sources by id, host, title and age, never by URL', () => {
    const messages = [
      message([webSearch('s1'), webResults('s1', ['https://www.example.com/fair']), fetchResult('f1', 'https://market.example.net/x', 'Market Wednesdays.')], { stopReason: 'pause_turn' }),
      message([
        citedQuotes('EVENT: Town Fair, May 15, 2027.', [{ url: 'https://www.example.com/fair', quote: 'Fair on May 15' }]),
        docCited(' EVENT: market.', [{ documentIndex: 0, quote: 'Market Wednesdays.' }]),
        text(' Done.'),
      ]),
    ];
    const ledger = buildLedger(messages);
    expect(citedText(messages, ledger)).toBe('EVENT: Town Fair, May 15, 2027. [S1] "Fair on May 15" EVENT: market. [S2] "Market Wednesdays." Done.');
    const thread = firstTownThread();
    const user = JSON.parse(extractPrompt({ messages, ledger, window, thread, competitors: COMPETITORS }).user) as Record<string, unknown>;
    expect(user.sources).toEqual([
      { id: 'S1', host: 'example.com', title: 'Sentinel-title 1', pageAge: '3 days ago' },
      { id: 'S2', host: 'market.example.net', title: 'Sentinel-doc-title', pageAge: null },
    ]);
    expect('competitors' in user).toBe(false);
    expect(JSON.stringify(user.sources)).not.toContain('https://');
  });
  // Live eval 2026-11-19: cited words keep a page's line breaks, which the JSON string escaped as \\n, and the extract
  // copied the escape into dateQuote ("Giant\\n\\nDec 05"), so grounding never found it in the page's words.
  it('collapses the cited words\' line breaks and runs of spaces, so a quote copied from them grounds', () => {
    const page = 'https://example.org/hop';
    const messages = [message([webSearch('s1'), webResults('s1', [page]), citedQuotes('EVENT: Giant.', [{ url: page, quote: '### Broadway in HD Giant\n\n2:00 PM  Spaulding\tAuditorium\n\nDec 05' }])])];
    const ledger = buildLedger(messages);
    const inline = citedText(messages, ledger);
    expect(inline).toBe('EVENT: Giant. [S1] "### Broadway in HD Giant 2:00 PM Spaulding Auditorium Dec 05"');
    expect(extractPrompt({ messages, ledger, window, thread: firstTownThread(), competitors: null }).user).not.toContain('\\n');
    // The ledger keeps the page's own words; grounding compares with spaces collapsed.
    expect(ledger.sources[0]?.quotes).toEqual(['### Broadway in HD Giant\n\n2:00 PM  Spaulding\tAuditorium\n\nDec 05']);
  });

  // Live eval 2026-11-19: 7 of 52 town findings quoted the gather's own sentence, not the cited words, so they could
  // never ground; and the gather's citations often quoted a page heading without the date.
  it('asks the extract to copy dateQuote from inside a cited quote of the event\'s own sources', () => {
    const { system } = extractPrompt({ messages: [], ledger: buildLedger([]), window, thread: firstTownThread(), competitors: null });
    expect(system).toMatch(/dateQuote: words copied exactly from inside the quotes after one of the event's own \[S#\] marks/);
    expect(system).toMatch(/never from the research text outside the quotes/);
  });

  it('asks the gather to state each date in the sentence that cites it', () => {
    const { system } = gatherPrompt({
      thread: firstTownThread(), town: promptTown(location.town), today: window.from, window, known: [], seeds: [], restaurant: null, competitors: null,
    });
    expect(system[0]?.text).toMatch(/Write each finding's date, with its year, in the sentence that cites it/);
  });
});
