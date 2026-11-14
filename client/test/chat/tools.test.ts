import { basedOnLine, isHiddenTool, isKnownTool, readsLine, toolLine, viewRows, type ToolStep } from '../../src/chat/tools';

// The client's tool table (spec P25). The names are listed here as api/test/chat-tools.test.ts lists the
// registry's (FROZEN_NAMES), in its order: the client can't import the API, so a PR that appends a tool updates both
// lists. get_town_calendar and get_people_in_town are U13A's, get_forecast U13B's; their views below are copied from
// api/test/chat-estimate-tools.test.ts. get_day is F2's; its views are copied from api/test/chat-tools.test.ts.
// show_visual and suggest_next are the chat redesign's (tuning-chat.md 4): hidden, with null views. get_owner_calendar
// reads the owner's own calendars; its views are copied from api/test/chat-owner-calendar.test.ts.

const REGISTERED = [
  'get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note',
  'get_town_calendar', 'get_people_in_town',
  'get_forecast',
  'get_day',
  'show_visual', 'suggest_next',
  'list_data_items', 'read_data_item', 'propose_data_item',
  // The forecast lab.
  'start_calibration', 'get_calibration', 'compare_forecast_models',
  // The owner's own calendars.
  'get_owner_calendar',
];
const CTX = { town: 'Hanover', hasTownProfile: true };

function step(name: string, state: ToolStep['state'], input: ToolStep['input'] = null, result: ToolStep['result'] = null): ToolStep {
  return { id: `toolu_test_${name}`, name, state, input, result };
}

test('every registered tool has words for each state; propose_note, propose_data_item, show_visual and suggest_next show as what they make', () => {
  for (const name of REGISTERED) {
    expect(isKnownTool(name)).toBe(true);
    const lines = (['running', 'done', 'error'] as const).map((state) => toolLine(step(name, state), CTX));
    // start_calibration starts a job rather than reading.
    expect(lines.map((line) => line.status))
      .toEqual(name === 'start_calibration' ? ['Starting', 'Asked to start', 'Couldn’t start'] : ['Reading', 'Read', 'Couldn’t read']);
    for (const line of lines) expect(line.object).not.toBe('');
  }
  expect(REGISTERED.filter(isHiddenTool)).toEqual(['propose_note', 'show_visual', 'suggest_next', 'propose_data_item']);
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
  // The people view exactly as api/test/chat-estimate-tools.test.ts asserts it (with a headcount input).
  const people = {
    available: true, town: { name: 'Hanover', state: 'NH' }, periods: 1, headcount: 'range',
    sources: [
      { host: 'census.example.test', url: 'https://census.example.test/p1' },
      { host: 'registrar.dartmouth.edu', url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates' },
      { host: 'bls.gov', url: 'https://www.bls.gov/cew/additional-resources/open-data/' },
    ],
  };
  expect(toolLine(step('get_people_in_town', 'done', range, people), CTX)).toMatchObject({
    sentence: 'Read who’s in Hanover for Nov 1 to Nov 30, 2026',
    detail: 'Headcount range from 3 sources · census.example.test · registrar.dartmouth.edu · bls.gov',
    sources: people.sources,
  });
  expect(viewRows(range, people, 'get_people_in_town')).toEqual([
    { term: 'From', value: 'Nov 1, 2026' }, { term: 'To', value: 'Nov 30, 2026' }, { term: 'Researched', value: 'Yes' },
    { term: 'Town', value: 'Hanover, NH' }, { term: 'Periods', value: '1' }, { term: 'Headcount', value: 'A range, with sources' },
  ]);
  // U13A's labels: "Reading {town}'s calendar for {range}", and an unresearched town reads its holidays only.
  expect(toolLine(step('get_town_calendar', 'running', range), CTX).sentence).toBe('Reading Hanover’s calendar for Nov 1 to Nov 30, 2026');
  // get_town_calendar's result view as U13A's tool sends it: { from, to, town, researched, eventCount, sources }.
  const calendar = { ...range, town: { name: 'Hanover', state: 'NH' }, researched: true, eventCount: 2, sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/c' }] };
  expect(toolLine(step('get_town_calendar', 'done', range, calendar), CTX)).toMatchObject({
    sentence: 'Read Hanover’s calendar for Nov 1 to Nov 30, 2026', detail: '2 events · dartmouth.edu',
  });
  expect(toolLine(step('get_town_calendar', 'done', range, { ...calendar, eventCount: 0, sources: [] }), CTX).detail).toBe('No events in this range');
  const bend = { ...range, town: { name: 'Bend', state: 'OR' }, researched: false, eventCount: 1, sources: [{ host: 'opm.gov', url: 'https://www.opm.gov/h' }] };
  expect(toolLine(step('get_town_calendar', 'done', range, bend), CTX)).toMatchObject({
    sentence: 'Read Bend’s calendar for Nov 1 to Nov 30, 2026', detail: 'Holidays only; Bend isn’t researched yet · opm.gov',
  });
  expect(viewRows(range, calendar)).toEqual([
    { term: 'From', value: 'Nov 1, 2026' }, { term: 'To', value: 'Nov 30, 2026' },
    { term: 'Town', value: 'Hanover, NH' }, { term: 'Researched', value: 'Yes' }, { term: 'Events', value: '2' },
  ]);
});

test('U13B’s row: the forecast, published runs only, never claimed when there is none', () => {
  const range = { from: '2026-11-02', to: '2026-11-04' };
  // Both views exactly as api/test/chat-estimate-tools.test.ts asserts them.
  const published = { available: true, modelVersion: 'v9', madeAt: '2026-11-01', dataThrough: '2026-10-31', days: 2, notCovered: 1 };
  const none = { available: false, modelVersion: null, madeAt: null, dataThrough: null, days: 0, notCovered: 0 };
  // model.md 5.6: "Reading Townwise's forecast for {range}", "Read the forecast for {range}".
  expect(toolLine(step('get_forecast', 'running', range), CTX).sentence).toBe('Reading Townwise’s forecast for Nov 2 to Nov 4, 2026');
  expect(toolLine(step('get_forecast', 'done', range, published), CTX)).toMatchObject({
    sentence: 'Read the forecast for Nov 2 to Nov 4, 2026', detail: 'Model v9, made Nov 1, 2026', sources: [],
  });
  expect(toolLine(step('get_forecast', 'done', range, none), CTX).detail).toBe('No forecast yet');
  expect(toolLine(step('get_forecast', 'error', range), CTX).sentence).toBe('Couldn’t read Townwise’s forecast for Nov 2 to Nov 4, 2026');
  expect(basedOnLine([step('get_forecast', 'done', range, none)], CTX)).toBe('Based on Townwise’s forecast for Nov 2 to Nov 4, 2026 (none yet).');
  expect(basedOnLine([step('get_forecast', 'done', range, published)], CTX)).toBe('Based on Townwise’s forecast for Nov 2 to Nov 4, 2026 (model v9).');
  // Its own words for `available`: a forecast is published, not "researched".
  expect(viewRows(range, published, 'get_forecast')).toEqual([
    { term: 'From', value: 'Nov 2, 2026' }, { term: 'To', value: 'Nov 4, 2026' }, { term: 'Forecast published', value: 'Yes' },
    { term: 'Model', value: 'v9' }, { term: 'Made', value: 'Nov 1, 2026' }, { term: 'Sales through', value: 'Oct 31, 2026' },
    { term: 'Days forecast', value: '2' }, { term: 'Days not covered', value: '1' },
  ]);
  expect(viewRows(range, none, 'get_forecast')).toEqual([
    { term: 'From', value: 'Nov 2, 2026' }, { term: 'To', value: 'Nov 4, 2026' }, { term: 'Forecast published', value: 'No' },
    { term: 'Days forecast', value: '0' }, { term: 'Days not covered', value: '0' },
  ]);
});

test('list_data_items and read_data_item say what the team added and how much was read, never a name', () => {
  expect(toolLine(step('list_data_items', 'running'), CTX).sentence).toBe('Reading what your team added');
  expect(toolLine(step('list_data_items', 'done', null, { count: 3, turnedOff: 1 }), CTX).detail).toBe('3 items, 1 turned off');
  expect(toolLine(step('list_data_items', 'done', null, { count: 0, turnedOff: 0 }), CTX).detail).toBe('Nothing added yet');
  expect(readsLine(CTX)).toContain('what your team added on Your data');
  const input = { ref: 'f_0123456789abcdef01234567' };
  expect(toolLine(step('read_data_item', 'running', input), CTX).sentence).toBe('Reading an item your team added');
  expect(toolLine(step('read_data_item', 'done', input, { ref: input.ref, available: true, chars: 900, truncated: false }), CTX).detail)
    .toBe('900 characters');
  expect(toolLine(step('read_data_item', 'done', input, { ref: input.ref, available: true, chars: 20000, truncated: true }), CTX).detail)
    .toBe('The start of it, 20,000 characters');
  expect(toolLine(step('read_data_item', 'done', input, { ref: input.ref, available: false, chars: 0, truncated: false }), CTX).detail)
    .toBe('Couldn’t read it');
  // One of a thing is singular.
  expect(toolLine(step('list_data_items', 'done', null, { count: 1, turnedOff: 0 }), CTX).detail).toBe('1 item, 0 turned off');
  expect(toolLine(step('read_data_item', 'done', input, { ref: input.ref, available: true, chars: 1, truncated: false }), CTX).detail).toBe('1 character');
});

test('the data rows’ opened cards and Based on pieces use their own words, and a refused read claims no read', () => {
  const input = { ref: 'f_0123456789abcdef01234567' };
  // The result views exactly as api/src/chat/tools/list-data.ts and read-data.ts build them; the ref is never a row.
  const read = { ref: input.ref, available: true, chars: 900, truncated: false };
  const refused = { available: false, chars: 0, truncated: false };
  expect(viewRows(null, { count: 3, turnedOff: 1 }, 'list_data_items')).toEqual([{ term: 'Items', value: '3' }, { term: 'Turned off', value: '1' }]);
  expect(viewRows(input, read, 'read_data_item')).toEqual([
    { term: 'Read', value: 'Yes' }, { term: 'Characters', value: '900' }, { term: 'Cut short', value: 'No' },
  ]);
  expect(viewRows(input, refused, 'read_data_item')).toEqual([
    { term: 'Read', value: 'No' }, { term: 'Characters', value: '0' }, { term: 'Cut short', value: 'No' },
  ]);
  expect(basedOnLine([step('list_data_items', 'done', null, { count: 3, turnedOff: 1 })], CTX)).toBe('Based on what your team added.');
  expect(basedOnLine([step('read_data_item', 'done', input, read)], CTX)).toBe('Based on an item your team added.');
  expect(basedOnLine([step('read_data_item', 'done', input, refused)], CTX)).toBe('Based on an item your team added (couldn’t read it).');
});

test('propose_data_item shows as its item card, not a row: it is not in the Based on line or in what TownwiseAI reads', () => {
  // The views exactly as api/src/chat/tools/propose-data.ts builds them.
  const input = { chars: 21 };
  expect(isHiddenTool('propose_data_item')).toBe(true);
  expect(basedOnLine([step('propose_data_item', 'done', input, { shown: true })], CTX)).toBe('Based on this conversation only.');
  expect(viewRows(input, { shown: true }, 'propose_data_item')).toEqual([]);
  expect(readsLine(CTX)).not.toMatch(/keep/);
});

test('get_day reads one day: whether it had sales, was closed, its notes and calendar entries, and their sources', () => {
  const input = { date: '2026-11-21' };
  const sources = [{ host: 'dartmouthsports.com', url: 'https://dartmouthsports.com/football' }];
  const read = { date: '2026-11-21', hasSales: true, closed: false, noteCount: 1, eventCount: 2, sources };
  expect(toolLine(step('get_day', 'running', input), CTX).sentence).toBe('Reading what Townwise has for Sat, Nov 21, 2026');
  expect(toolLine(step('get_day', 'done', input, read), CTX)).toMatchObject({
    sentence: 'Read what Townwise has for Sat, Nov 21, 2026', detail: 'Sales recorded · 1 note · 2 calendar entries · dartmouthsports.com', sources,
  });
  expect(toolLine(step('get_day', 'done', input, { date: '2026-11-26', hasSales: false, closed: true, noteCount: 0, eventCount: 0, sources: [] }), CTX).detail)
    .toBe('No sales recorded · Closed');
  expect(toolLine(step('get_day', 'error'), CTX).sentence).toBe('Couldn’t read what Townwise has for a day');
  expect(basedOnLine([step('get_day', 'done', input, read)], CTX)).toBe('Based on what Townwise has for Sat, Nov 21, 2026.');
  expect(viewRows(input, read, 'get_day')).toEqual([
    { term: 'Day', value: 'Nov 21, 2026' }, { term: 'Sales recorded', value: 'Yes' }, { term: 'Closed', value: 'No' },
    { term: 'Notes', value: '1' }, { term: 'Calendar entries', value: '2' },
  ]);
});

test('the lab tools read counts and codes: whether a calibration started, its status, the weeks it was judged on', () => {
  const started = { started: true, status: 'running', code: null };
  expect(toolLine(step('start_calibration', 'running', { hasRegimeStart: false }), CTX).sentence).toBe('Starting a forecast calibration');
  expect(toolLine(step('start_calibration', 'done', { hasRegimeStart: false }, started), CTX))
    .toMatchObject({ sentence: 'Started a forecast calibration', detail: 'Running on Townwise’s servers' });
  const refused = { started: false, status: null, code: 'in_progress' };
  expect(toolLine(step('start_calibration', 'done', null, refused), CTX))
    .toMatchObject({ sentence: 'Didn’t start a forecast calibration', detail: 'One is already running for this location' });
  expect(toolLine(step('start_calibration', 'done', null, { started: false, status: null, code: 'a_new_code' }), CTX).detail).toBeNull();
  expect(toolLine(step('start_calibration', 'error'), CTX).sentence).toBe('Couldn’t start a forecast calibration');
  // Its codes show as words, never as the code.
  expect(viewRows({ hasRegimeStart: true }, refused, 'start_calibration')).toEqual([
    { term: 'Pattern change date given', value: 'Yes' }, { term: 'Started', value: 'No' }, { term: 'Reason', value: 'One is already running for this location' },
  ]);
  expect(viewRows(null, started, 'start_calibration')).toEqual([{ term: 'Started', value: 'Yes' }, { term: 'Status', value: 'Running' }]);

  const read = { available: true, status: 'succeeded', weeks: 12, published: true };
  expect(toolLine(step('get_calibration', 'done', null, read), CTX)).toMatchObject({
    sentence: 'Read your latest forecast calibration', detail: '12 held-out weeks · Published',
  });
  expect(toolLine(step('get_calibration', 'done', null, { available: true, status: 'running', weeks: null, published: null }), CTX).detail).toBe('Still running');
  expect(toolLine(step('get_calibration', 'done', null, { available: true, status: 'queued', weeks: null, published: null }), CTX).detail).toBe('Waiting to start');
  // get_calibration's failed view (api/src/chat/tools/calibration.ts) says so, as the opened card does.
  const failed = { available: true, status: 'failed', weeks: null, published: null };
  expect(toolLine(step('get_calibration', 'done', null, failed), CTX).detail).toBe('Didn’t finish');
  expect(viewRows(null, failed, 'get_calibration')).toEqual([{ term: 'Available', value: 'Yes' }, { term: 'Status', value: 'Didn’t finish' }]);
  expect(toolLine(step('compare_forecast_models', 'done', null, { available: false, status: null, weeks: null, published: null }), CTX).detail)
    .toBe('Nothing to show yet');
  expect(toolLine(step('compare_forecast_models', 'done', null, { ...read, published: false }), CTX).detail).toBe('12 held-out weeks · Not published');
  expect(toolLine(step('compare_forecast_models', 'running'), CTX).sentence).toBe('Reading how the calibration compares with the current forecast');
  // A calibration's id is left out of the opened card.
  expect(viewRows({ calibrationId: 'a'.repeat(24) }, read, 'get_calibration')).toEqual([
    { term: 'Available', value: 'Yes' }, { term: 'Status', value: 'Finished' }, { term: 'Held-out weeks', value: '12' }, { term: 'Published', value: 'Yes' },
  ]);

  // Starting one reads nothing, so it is no part of the Based on line.
  const start = step('start_calibration', 'done', null, started);
  expect(basedOnLine([start], CTX)).toBe('Based on this conversation only.');
  expect(basedOnLine([start, step('get_calibration', 'done', null, read)], CTX)).toBe('Based on your latest forecast calibration.');
});

test('get_owner_calendar says how many events it read from how many calendars, never a title or a calendar’s name', () => {
  const range = { from: '2026-11-16', to: '2026-11-22' };
  // The result views exactly as api/src/chat/tools/owner-calendar.ts builds them.
  const read = { available: true, calendars: 2, eventCount: 2, truncated: false, skippedRepeating: 3 };
  const none = { available: false, calendars: 0, eventCount: 0, truncated: false, skippedRepeating: 0 };
  expect(toolLine(step('get_owner_calendar', 'running', range), CTX).sentence).toBe('Reading your calendars for Nov 16 to Nov 22, 2026');
  expect(toolLine(step('get_owner_calendar', 'done', range, read), CTX)).toMatchObject({
    sentence: 'Read your calendars for Nov 16 to Nov 22, 2026', detail: '2 events from 2 calendars', sources: [],
  });
  expect(toolLine(step('get_owner_calendar', 'done', range, { ...read, calendars: 1, eventCount: 1 }), CTX).detail).toBe('1 event from 1 calendar');
  expect(toolLine(step('get_owner_calendar', 'done', range, { ...read, eventCount: 0 }), CTX).detail).toBe('No events in this range');
  expect(toolLine(step('get_owner_calendar', 'done', range, { ...read, calendars: 5, eventCount: 100, truncated: true }), CTX).detail)
    .toBe('The first 100 events from 5 calendars');
  expect(toolLine(step('get_owner_calendar', 'done', range, none), CTX).detail).toBe('No calendar connected');
  expect(toolLine(step('get_owner_calendar', 'error', range), CTX).sentence).toBe('Couldn’t read your calendars for Nov 16 to Nov 22, 2026');

  expect(basedOnLine([step('get_owner_calendar', 'done', range, read)], CTX)).toBe('Based on your calendars for Nov 16 to Nov 22, 2026.');
  expect(basedOnLine([step('get_owner_calendar', 'done', range, none)], CTX)).toBe('Based on your calendars for Nov 16 to Nov 22, 2026 (none connected).');
  // Its own words for `available` (a calendar is connected, not "researched") and for its counts.
  expect(viewRows(range, read, 'get_owner_calendar')).toEqual([
    { term: 'From', value: 'Nov 16, 2026' }, { term: 'To', value: 'Nov 22, 2026' }, { term: 'Calendar connected', value: 'Yes' },
    { term: 'Calendars', value: '2' }, { term: 'Events', value: '2' }, { term: 'Cut short', value: 'No' },
    { term: 'Repeating events not imported', value: '3' },
  ]);

  // What TownwiseAI reads names the owner's calendars only once the page knows the location has one.
  expect(readsLine(CTX)).not.toMatch(/your calendars/);
  expect(readsLine({ ...CTX, hasCalendar: false })).not.toMatch(/your calendars/);
  expect(readsLine({ ...CTX, hasCalendar: true }))
    .toBe('your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover, what your team added on Your data and your calendars');
});

test('a tool this table doesn’t know yet still gets a card, in general words', () => {
  expect(isKnownTool('get_weather')).toBe(false);
  expect(['running', 'done', 'error'].map((state) => toolLine(step('get_weather', state as ToolStep['state']), CTX).sentence))
    .toEqual(['Looking something up', 'Looked something up', 'Couldn’t look something up']);
  expect(toolLine(step('get_weather', 'done', null, { anything: 1 }), CTX)).toMatchObject({ status: '', detail: null, sources: [] });
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
  expect(basedOnLine([step('get_weather', 'done')], CTX)).toBe('Based on something else TownwiseAI looked up.');
  expect(basedOnLine([], CTX)).toBe('Based on this conversation only.');
  expect(basedOnLine([step('list_notes', 'error')], CTX)).toBe('Based on this conversation only.');
});

test('what TownwiseAI reads lists the registered tools that have something to read, and a forecast only once one is published', () => {
  expect(readsLine(CTX)).toBe('your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data');
  // A town outside the twelve has no profile and no people in town to read; its calendar is the federal holidays.
  expect(readsLine({ town: 'Bend', hasTownProfile: false })).toBe('your sales, your notes, the town calendar and what your team added on Your data');
  expect(readsLine(CTX)).not.toMatch(/forecast/);
  expect(readsLine({ ...CTX, hasForecast: false })).not.toMatch(/forecast/);
  // F10: GET .../estimates/about says a run is published.
  expect(readsLine({ ...CTX, hasForecast: true }))
    .toBe('your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover, Townwise’s forecast and what your team added on Your data');
});

test('before any sales are uploaded, what TownwiseAI can use leaves out the sales and keeps every other source', () => {
  expect(readsLine(CTX, { sales: false })).toBe('your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data');
  expect(readsLine({ town: 'Bend', hasTownProfile: false }, { sales: false })).toBe('your notes, the town calendar and what your team added on Your data');
  expect(readsLine({ ...CTX, hasForecast: true }, { sales: false }))
    .toBe('your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover, Townwise’s forecast and what your team added on Your data');
  // A context that says the location has no sales leaves them out of every line built from it.
  expect(readsLine({ ...CTX, hasSales: false })).toBe('your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data');
  expect(readsLine({ ...CTX, hasSales: true })).toBe(readsLine(CTX));
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
