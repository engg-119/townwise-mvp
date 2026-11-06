import { basedOnLine, isHiddenTool, isKnownTool, readsLine, toolLine, viewRows, type ToolStep } from '../../src/chat/tools';

// The client's tool table (spec P25). The names are listed here as api/test/chat-tools.test.ts lists the
// registry's: the client can't import the API, so a PR that appends a tool updates both lists. get_town_calendar and
// get_people_in_town are U13A's; their rows are ready for when they land.

const REGISTERED = ['get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note'];
const AHEAD = ['get_town_calendar', 'get_people_in_town'];
const CTX = { town: 'Hanover' };

function step(name: string, state: ToolStep['state'], input: ToolStep['input'] = null, result: ToolStep['result'] = null): ToolStep {
  return { id: `toolu_test_${name}`, name, state, input, result };
}

test('every registered tool, and the two U13A tools, has words for each state; propose_note shows as its card', () => {
  for (const name of [...REGISTERED, ...AHEAD]) {
    expect(isKnownTool(name)).toBe(true);
    const lines = (['running', 'done', 'error'] as const).map((state) => toolLine(step(name, state), CTX));
    expect(lines.map((line) => line.status)).toEqual(['Reading', 'Read', 'Couldn’t read']);
    for (const line of lines) expect(line.object).not.toBe('');
  }
  expect(REGISTERED.filter(isHiddenTool)).toEqual(['propose_note']);
});

test('the rows read the views: dates, counts and source links only', () => {
  expect(toolLine(step('get_sales_days', 'running', { from: '2026-10-01', to: '2026-10-31' }), CTX).sentence)
    .toBe('Reading your sales for Oct 1 to Oct 31, 2026');
  const sales = toolLine(step('get_sales_days', 'done', { from: '2026-10-01', to: '2026-10-31' }, { dayCount: 31, guestsDayCount: 31, netSalesDayCount: 30 }), CTX);
  expect(sales).toMatchObject({ sentence: 'Read your sales for Oct 1 to Oct 31, 2026', detail: '31 days: guests on 31, net sales on 30' });
  expect(toolLine(step('get_sales_days', 'done', { from: '2026-10-01', to: '2026-10-31' }, { dayCount: 0 }), CTX).detail).toBe('No sales in this range');

  expect(toolLine(step('get_location_overview', 'done', null, { firstDate: '2024-01-01', lastDate: '2026-11-15', dayCount: 1050, missingDays: 3 }), CTX).detail)
    .toBe('1,050 days, Jan 1, 2024 to Nov 15, 2026, 3 days missing');
  expect(toolLine(step('get_location_overview', 'done', null, { firstDate: null, lastDate: null, dayCount: 0, missingDays: 0 }), CTX).detail)
    .toBe('No sales uploaded yet');

  expect(toolLine(step('list_notes', 'done', null, { count: 12 }), CTX).detail).toBe('12 notes');
  expect(toolLine(step('list_notes', 'done', null, { count: 0 }), CTX).detail).toBe('No notes yet');

  const profile = toolLine(step('get_town_profile', 'done', null, {
    available: true, town: { name: 'Hanover', state: 'NH' },
    sources: [{ host: 'bls.gov', url: 'https://bls.gov/x' }, { host: 'census.gov', url: 'https://census.gov/y' }, { host: 'bad', url: 'http://plain.example' }],
  }), CTX);
  expect(profile).toMatchObject({ sentence: 'Read Hanover’s town profile', detail: 'bls.gov · census.gov' });
  // Only https links are offered.
  expect(profile.sources).toEqual([{ host: 'bls.gov', url: 'https://bls.gov/x' }, { host: 'census.gov', url: 'https://census.gov/y' }]);
  expect(toolLine(step('get_town_profile', 'done', null, { available: false, town: null, sources: [] }), CTX).detail)
    .toBe('Townwise hasn’t researched this town yet');

  // A failed call shows no detail and no links.
  expect(toolLine(step('list_notes', 'error', null, { count: 12 }), CTX)).toMatchObject({ sentence: 'Couldn’t read your notes', detail: null, sources: [] });
});

test('U13A’s rows: who is in town and the town calendar', () => {
  const range = { from: '2026-11-01', to: '2026-11-30' };
  expect(toolLine(step('get_people_in_town', 'running', range), CTX).sentence).toBe('Reading who’s in Hanover for Nov 1 to Nov 30, 2026');
  expect(toolLine(step('get_people_in_town', 'done', range, { available: true, town: 'Hanover', periods: 2, headcount: 'none', sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/a' }] }), CTX).detail)
    .toBe('No headcount yet · dartmouth.edu');
  expect(toolLine(step('get_people_in_town', 'done', range, {
    available: true, headcount: 'range',
    sources: [{ host: 'census.gov', url: 'https://census.gov/a' }, { host: 'dartmouth.edu', url: 'https://dartmouth.edu/a' }, { host: 'bls.gov', url: 'https://bls.gov/a' }],
  }), CTX).detail).toBe('Headcount range from 3 sources · census.gov · dartmouth.edu · bls.gov');
  expect(toolLine(step('get_town_calendar', 'running', range), CTX).sentence).toBe('Reading Hanover’s town calendar for Nov 1 to Nov 30, 2026');
  // get_town_calendar's result view as U13A's tool sends it: { from, to, town, researched, eventCount, sources }.
  const calendar = { ...range, town: { name: 'Hanover', state: 'NH' }, researched: true, eventCount: 2, sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/c' }] };
  expect(toolLine(step('get_town_calendar', 'done', range, calendar), CTX).detail).toBe('2 events · dartmouth.edu');
  expect(toolLine(step('get_town_calendar', 'done', range, { ...calendar, eventCount: 0, sources: [] }), CTX).detail).toBe('No events in this range');
  expect(toolLine(step('get_town_calendar', 'done', range, { ...calendar, researched: false, eventCount: 0, sources: [] }), CTX).detail)
    .toBe('Townwise hasn’t researched this town’s calendar yet');
  expect(viewRows(range, calendar)).toEqual([
    { term: 'From', value: 'Nov 1, 2026' }, { term: 'To', value: 'Nov 30, 2026' },
    { term: 'Town', value: 'Hanover, NH' }, { term: 'Researched', value: 'Yes' }, { term: 'Events', value: '2' },
  ]);
});

test('a tool this table doesn’t know yet still gets a card, in general words', () => {
  expect(isKnownTool('get_day')).toBe(false);
  expect(['running', 'done', 'error'].map((state) => toolLine(step('get_day', state as ToolStep['state']), CTX).sentence))
    .toEqual(['Looking something up', 'Looked something up', 'Couldn’t look something up']);
  expect(toolLine(step('get_day', 'done', null, { anything: 1 }), CTX)).toMatchObject({ status: '', detail: null, sources: [] });
  // Prototype names are not tools.
  expect(isKnownTool('toString')).toBe(false);
});

test('the Based on line comes from the calls that read something, never the model', () => {
  const steps = [
    step('get_sales_days', 'done', { from: '2026-10-01', to: '2026-10-31' }, { dayCount: 31 }),
    step('list_notes', 'done', null, { count: 12 }),
    step('get_town_profile', 'done', null, { available: true, town: { name: 'Hanover', state: 'NH' }, sources: [{ host: 'bls.gov', url: 'https://bls.gov/x' }, { host: 'dartmouth.edu', url: 'https://dartmouth.edu/y' }] }),
    step('list_notes', 'done', null, { count: 12 }),
    step('get_location_overview', 'error'),
    step('propose_note', 'done'),
  ];
  expect(basedOnLine(steps, CTX)).toBe('Based on your sales from Oct 1 to Oct 31, 2026, your 12 notes, and Hanover’s town profile (bls.gov, dartmouth.edu).');
  expect(basedOnLine(steps.slice(0, 2), CTX)).toBe('Based on your sales from Oct 1 to Oct 31, 2026 and your 12 notes.');
  expect(basedOnLine([step('get_day', 'done')], CTX)).toBe('Based on something else TownwiseAI looked up.');
  expect(basedOnLine([], CTX)).toBe('Based on this conversation only.');
  expect(basedOnLine([step('list_notes', 'error')], CTX)).toBe('Based on this conversation only.');
});

test('what TownwiseAI reads lists only tools the server has, so U13A’s rows add nothing until they land', () => {
  expect(readsLine(CTX)).toBe('your sales, your notes and Hanover’s town profile');
});

test('an opened card lists the views in words, and never a field it has no words for', () => {
  expect(viewRows({ from: '2026-10-01', to: '2026-10-31' }, { from: '2026-10-01', to: '2026-10-31', dayCount: 31, guestsDayCount: 31, netSalesDayCount: 30 }))
    .toEqual([
      { term: 'From', value: 'Oct 1, 2026' }, { term: 'To', value: 'Oct 31, 2026' }, { term: 'Days', value: '31' },
      { term: 'Days with guests', value: '31' }, { term: 'Days with net sales', value: '30' },
    ]);
  expect(viewRows(null, { available: true, town: { name: 'Hanover', state: 'NH' }, sources: [], guests: 1200, netSales: 5 }))
    .toEqual([{ term: 'Researched', value: 'Yes' }, { term: 'Town', value: 'Hanover, NH' }]);
  expect(viewRows(null, null)).toEqual([]);
});
