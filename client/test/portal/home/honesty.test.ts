import { dayContext } from '../../../src/portal/analytics/days';
import { byDate, type DayRecord } from '../../../src/portal/analytics/history';
import {
  calendarCoverageLine, calendarWeekLine, lastWeekComparison, lastWeekLine, LAST_YEAR_FOOTNOTE, lateWeekLine, lateWeekShare, leadLine,
  forecastRange, mondayOf, monthDay, monthFactLine, monthFacts, monthGrid, nextEvent, nextEventWhen, pastDay, sameWeekdayYearsAgo, summaryLabel, thisWeek,
  vsUsualLine, weekDates, type HomeInput,
} from '../../../src/portal/analytics/week';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastDay, ForecastWindow } from '../../../src/portal/estimates/api';
import { addDays, monthRange } from '../../../src/portal/locations/dates';
import { orderCoverSentence, REORDER_OVERVIEW } from '../../../src/portal/home/beside';
import { barOrderWords } from '../../../src/portal/home/BarOrder';
import { forecastDayLines } from '../../../src/portal/home/DayDetail';
import type { LiveBoard, OrderLine } from '../../../src/portal/orders/api';
import { lastWeekGlance } from '../../../src/portal/home/Glance';
import { forecastLine, questionsLabel } from '../../../src/portal/home/Home';
import { PEOPLE_HEAD } from '../../../src/portal/home/ThisMonth';
import { OWNER_REASONS } from '../../../src/portal/schemas';
import { firstForecastLine, notPublishedLine } from '../../../src/portal/upload/copy';
import { calendarBody, holiday, note, run, townEvent } from '../analytics/fakes';
import { forecastDay } from '../calendar/fakes';

// Home's honesty rule (home.md 0, build plan 6 U8): no number is ever given for a day after the last day of data
// or after today, and nothing Home says reads as a forecast. It checks the computations that every figure on Home
// comes from, over histories that end before this week, inside it and long ago, and every sentence Home builds.
// home.test.web.tsx checks the same rule in the rendered page.

const TODAY = '2026-11-05';
const FORECAST_WORDING = /\blikely\b|\branges?\b|forecast:\s*\d|\bpredict|\bexpect(ed|s)?\b/i;
const NOTES = [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })];
const EVENTS = [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })];
const CONTEXT = dayContext(NOTES, EVENTS);
const ALL = run('2023-01-01', '2026-11-04', (date) => 100 + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 40 : 0));

function input(lastDate: string): HomeInput {
  const days: DayRecord[] = ALL.filter((day) => day.date <= lastDate);
  return { today: TODAY, byDate: byDate(days), context: CONTEXT, metric: 'guests', lastDate: days.at(-1)?.date ?? null };
}

/** Home's one CalendarInput (D49) over `home`'s stored days; `forecast` null is a read that hasn't answered. */
function calendarOf(home: HomeInput, forecast: ForecastWindow | null = null): CalendarInput {
  return {
    today: TODAY, covered: forecastRange(TODAY), forecast, salesDays: [...home.byDate.values()], events: EVENTS, notes: NOTES, rules: [], imported: [],
    filters: ALL_FILTERS,
  };
}

const ENDINGS = ['2026-11-04', '2026-11-02', '2026-10-28', '2026-10-20', '2025-12-31', '2025-06-30'];

describe.each(ENDINGS)('history ending %s', (end) => {
  const home = input(end);

  test('this week gives no figure after the last day of data', () => {
    for (const row of thisWeek(home).rows) {
      if (row.date > end) expect(row.value).toBeNull();
      for (const past of [row.lastYear, row.twoYearsAgo]) {
        if (past.date > end) expect([past.value, past.usual, past.change]).toEqual([null, null, null]);
      }
    }
  });

  test('last week, the bar order share and this month count only stored, past days', () => {
    const comparison = lastWeekComparison(home);
    if (comparison.state !== 'no_history' && comparison.state !== 'uploads_off' && comparison.state !== 'no_recent' && comparison.state !== 'no_days') {
      for (const day of comparison.days) {
        if (day.date > end) expect(day.value).toBeNull();
      }
    }
    // Last year's Thursday to Sunday of this week: no share unless all four are stored, past days. In ALL that
    // week is 100 a day with Saturday 140, so Thursday to Sunday is 440 of 740.
    const late = weekDates(sameWeekdayYearsAgo(mondayOf(TODAY), 1)).slice(3);
    const share = lateWeekShare(home);
    if (late.some((date) => date > end)) expect(share).toBeNull();
    else expect(share).toEqual({ share: 440 / 740, days: 7 });
    for (const fact of monthFacts(home)) expect(fact.year).toBeLessThan(2026);
  });

  test('the month card’s day detail gives no figure after the last day of data or after today', () => {
    const { from, to } = monthRange(TODAY.slice(0, 7));
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const day = monthDay(date, home);
      if (date > end || date > TODAY) expect(day.value).toBeNull();
      if (date > TODAY) expect(day.future).toBe(true);
      for (const past of [day.lastYear, day.twoYearsAgo]) {
        if (past.date > end) expect([past.value, past.usual, past.change]).toEqual([null, null, null]);
      }
    }
  });

  // D49 (design decision 9): Home's grid is the Calendar's, so with a forecast read a past day with no stored data shows
  // the run's own figure captioned "forecast" (month-figure-parity.test.ts); while it hasn't answered, nothing.
  test('monthGrid gives no figure after today without a forecast, and none after the last day of data', () => {
    for (const cell of monthGrid(TODAY, calendarOf(home)).flat()) {
      if (cell === null) continue;
      if (cell.date >= TODAY || cell.date > end) expect(cell.figure).toBeNull();
      else expect(cell.figure?.kind).toBe('actual');
      expect([cell.status, cell.noteGuests]).toEqual([null, 0]);
    }
  });

  test('every sentence Home builds is free of forecast wording', () => {
    const week = thisWeek(home);
    const sentences = [
      leadLine(home.lastDate, calendarBody()), calendarWeekLine(week, calendarBody()), calendarCoverageLine(calendarBody()),
      lastWeekLine(lastWeekComparison(home), 'guests'), lastWeekGlance(lastWeekComparison(home), 'guests'),
      ...monthFacts(home).map((fact) => monthFactLine(fact, 'guests')),
    ];
    const next = nextEvent(TODAY, CONTEXT);
    if (next !== null) sentences.push(nextEventWhen(next));
    if (week.summary !== null) sentences.push(summaryLabel(week.summary), vsUsualLine(week.summary) ?? '');
    const share = lateWeekShare(home);
    if (share !== null) sentences.push(lateWeekLine(share, 'guests'));
    for (const sentence of sentences) expect(sentence).not.toMatch(FORECAST_WORDING);
  });
});

test('a day after today has no figure even when a row for it is stored', () => {
  const future = [...ALL, { date: '2026-11-06', guests: 999, netSalesCents: 1, upload: 0 }];
  const home: HomeInput = { today: TODAY, byDate: byDate(future), context: CONTEXT, metric: 'guests', lastDate: '2026-11-06' };
  expect(thisWeek(home).rows.find((row) => row.date === '2026-11-06')?.value).toBeNull();
  expect(pastDay('2026-11-06', home).value).toBeNull();
  expect(monthDay('2026-11-06', home).value).toBeNull();
});

test('a future day’s figure is only ever the published forecast’s mid', () => {
  // A stored row after today (999) never shows; from today on only the forecast's own figures do.
  const stored = [...ALL, ...['2026-11-05', '2026-11-06', '2026-11-09'].map((date) => ({ date, guests: 999, netSalesCents: 1, upload: 0 }))];
  const home: HomeInput = { today: TODAY, byDate: byDate(stored), context: CONTEXT, metric: 'guests', lastDate: '2026-11-09' };
  const booked = { kind: 'note', label: 'Your private buyout, 70 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 70, outcome: 'booked' } };
  const forecast = new Map<string, ForecastDay>([
    ['2026-11-05', forecastDay({ date: '2026-11-05', low: 180.4, mid: 211.6, high: 240.2 })],
    ['2026-11-06', forecastDay({
      date: '2026-11-06', low: 180, mid: 220, high: 260, model: { status: 'open', low: 110, mid: 150, high: 190 }, noteGuests: 70,
    })],
    ['2026-11-07', forecastDay({ date: '2026-11-07', status: 'booked', low: null, mid: null, high: null, noteGuests: 70, reasons: [booked] })],
    ['2026-11-08', forecastDay({ date: '2026-11-08', status: 'closed', low: null, mid: null, high: null })],
  ]);
  const window: ForecastWindow = { available: true, reason: null, runs: [], days: [...forecast.values()], weeks: [] };
  const cells = new Map(monthGrid(TODAY, calendarOf(home, window)).flat().flatMap((cell) => (cell === null ? [] : [[cell.date, cell]])));
  const at = (date: string) => cells.get(date);
  expect([at('2026-11-04')?.figure, at('2026-11-04')?.figureText]).toEqual([{ value: 100, kind: 'actual' }, '100']);
  expect([at('2026-11-05')?.figure, at('2026-11-05')?.figureText]).toEqual([{ value: 212, kind: 'forecast' }, '~212']);
  // The range rounds low down and high up, as the Calendar, spec 14.4 and TownwiseAI's get_forecast do.
  expect(at('2026-11-05')?.label).toBe('Thu, Nov 5, 2026. Today. This week. 212 guests, forecast, likely 180 to 241.');
  expect(forecastDayLines(forecast.get('2026-11-05') ?? forecastDay({ date: '' }))).toEqual(['About 212 guests, likely 180 to 241.']);
  expect(at('2026-11-06')?.figure).toEqual({ value: 220, kind: 'forecast' });
  expect(at('2026-11-06')?.noteGuests).toBe(70);
  // The label names every entry (D49): the note by its kind words.
  expect(at('2026-11-06')?.label).toBe('Fri, Nov 6, 2026. This week. 220 guests, forecast, likely 180 to 260. Includes 70 guests from your notes. Private event.');
  expect([at('2026-11-07')?.figure, at('2026-11-07')?.figureText]).toEqual([{ value: 70, kind: 'booked' }, '~70']);
  expect(at('2026-11-07')?.status).toBe('booked');
  expect(at('2026-11-07')?.label).toBe('Sat, Nov 7, 2026. This week. Booked: a private buyout, 70 guests, forecast. Sample game.');
  expect([at('2026-11-08')?.figure, at('2026-11-08')?.status]).toEqual([null, 'closed']);
  expect(at('2026-11-08')?.label).toBe('Sun, Nov 8, 2026. This week. Closed.');
  // No forecast day: no figure, even with a stored row; the Calendar's word says so.
  expect([at('2026-11-09')?.figure, at('2026-11-09')?.status]).toEqual([null, 'no_forecast']);
  for (const cell of cells.values()) expect(cell.figure?.value).not.toBe(999);
});

test('an outlook day’s figures are the published run’s own too (D52): Home never computes, sums or adjusts them', () => {
  const home: HomeInput = { today: TODAY, byDate: byDate(ALL), context: CONTEXT, metric: 'guests', lastDate: '2026-11-04' };
  const outlook = forecastDay({ date: '2026-11-09', low: 150.4, mid: 211.6, high: 289.2, model: { status: 'open', low: 150.4, mid: 211.6, high: 289.2 }, outlook: true });
  const window: ForecastWindow = { available: true, reason: null, runs: [], days: [outlook], weeks: [] };
  const cell = monthGrid(TODAY, calendarOf(home, window)).flat().find((each) => each?.date === outlook.date);
  expect([cell?.figure, cell?.figureText]).toEqual([{ value: 212, kind: 'forecast' }, '~212']);
  expect(cell?.status).toBe('outlook');
  expect(cell?.label).toBe('Mon, Nov 9, 2026. This week. Outlook: 212 guests, forecast, likely 150 to 290.');
  expect(forecastDayLines(outlook)).toEqual(['About 212 guests, likely 150 to 290.']);
});

test('no history at all: no figure anywhere', () => {
  const home: HomeInput = { today: TODAY, byDate: new Map(), context: CONTEXT, metric: 'guests', lastDate: null };
  const week = thisWeek(home);
  expect(week.rows.every((row) => row.value === null && row.lastYear.value === null && row.twoYearsAgo.value === null)).toBe(true);
  expect(week.summary).toBeNull();
  expect(lastWeekComparison(home)).toEqual({ state: 'no_history' });
  expect(lateWeekShare(home)).toBeNull();
  expect(monthFacts(home)).toEqual([]);
});

test('the fixed copy names what is not built yet and promises nothing', () => {
  for (const line of [forecastLine('Main Street Bar'), PEOPLE_HEAD]) {
    expect(line).not.toMatch(FORECAST_WORDING);
    expect(line).not.toMatch(/\d/);
  }
  expect(LAST_YEAR_FOOTNOTE).not.toMatch(FORECAST_WORDING);
  expect(forecastLine('Main Street Bar')).toBe('Townwise hasn’t published a forecast for Main Street Bar yet. Until then, Home shows your history and the calendar, never a guess.');
  const glance = [
    REORDER_OVERVIEW,
    orderCoverSentence('2026-11-12', null),
    orderCoverSentence('2026-11-12', { sample: false, supplier: 'Sample distributor', cutoff: '2026-11-11', delivery: '2026-11-12', coversThrough: '2026-11-16' }),
    orderCoverSentence('2026-11-20', { sample: true, supplier: 'Sample distributor', cutoff: '2026-11-11', delivery: '2026-11-12', coversThrough: '2026-11-16' }),
  ];
  for (const line of glance) expect(line).not.toMatch(FORECAST_WORDING);
  // The questions link is a count of what GET .../agent asks, and nothing more.
  expect(questionsLabel(1)).toBe('1 question from TownwiseAI');
  expect(questionsLabel(5)).toBe('5 questions from TownwiseAI');
  expect(questionsLabel(1200)).toBe('1,200 questions from TownwiseAI');
  expect(questionsLabel(2)).not.toMatch(FORECAST_WORDING);
});

// D65: Home's first-forecast lines and its not-published notice promise a run, never a publish or a figure: no
// forecast wording, no number (no minimum history, 14.1), and "next" never says Building or a time (14.2).
test('the first-forecast lines and the not-published notice promise no publish and state no number', () => {
  const history = { dayCount: 795, firstDate: '2024-09-01', lastDate: '2026-11-04' };
  const since = '2026-11-05T15:30:00.000Z';
  const waiting = firstForecastLine({ state: 'not_calibrated', ...history, updating: { stage: 'waiting', since }, lastRun: null }, 'Main Street Bar');
  const building = firstForecastLine({ state: 'not_calibrated', ...history, updating: { stage: 'running', since }, lastRun: null }, 'Main Street Bar');
  for (const line of [waiting, building]) {
    expect(line).not.toBeNull();
    expect(line).not.toMatch(FORECAST_WORDING);
    expect(line).not.toMatch(/\d/);
  }
  expect(waiting).not.toMatch(/Building|publish/);
  for (const reason of OWNER_REASONS) {
    const notice = notPublishedLine(
      { state: 'not_calibrated', ...history, updating: null, lastRun: { outcome: 'kept', reason, finishedAt: since } }, 'Main Street Bar',
    );
    if (reason === 'published' || reason === 'published_by_staff') {
      expect(notice).toBeNull();
      continue;
    }
    expect(notice?.text).not.toMatch(FORECAST_WORDING);
    expect(`${notice?.text ?? ''} ${notice?.next ?? ''}`).not.toMatch(/\d/);
  }
});

// #68 review S2: the reorder copy on Home's selected day and on Orders describes the method the board runs
// (api/src/orders/engine.ts), and claims nothing it does not do: no prices, no promise never to run out, no sight of
// stock beyond the counts, and nothing sent or placed for the owner.
test('the reorder copy says how the board works and promises nothing it doesn’t do', () => {
  expect(REORDER_OVERVIEW).not.toMatch(FORECAST_WORDING);
  for (const word of [/price|cost|cheap|margin/i, /never run|guarantee|always/i, /\bstock\b|on hand|inventory/i, /automatic|for you\b/i]) {
    expect(REORDER_OVERVIEW).not.toMatch(word);
  }
  expect(REORDER_OVERVIEW).toMatch(/weekday over the last 8 weeks/);
  expect(REORDER_OVERVIEW).toMatch(/guest forecast when one is published/);
  expect(REORDER_OVERVIEW).toMatch(/minus your last count/);
  expect(REORDER_OVERVIEW).toMatch(/You place every order yourself; nothing is sent to a distributor\.$/);
  expect(REORDER_OVERVIEW).not.toMatch(/—/);
});

function line(fields: Partial<OrderLine> & Pick<OrderLine, 'itemId' | 'recommended'>): OrderLine {
  return {
    name: fields.itemId, supplier: 'Sample distributor', unit: 'cases', neverRunOut: false, alternative: null, par: 2, mu: null, sigma: null,
    orderUpTo: null, target: 0.95, onHand: null, countAgeDays: null, confidence: 'low', dealSize: null, coveredDays: 0, why: '', sample: false,
    edit: null, rules: [], ...fields,
  };
}

// #68 review C5: the count and the deadline are the soonest order's, so the number is the one due by that deadline.
test('Home’s bar order card counts the soonest order’s items with its deadline and says what is missing, never a quantity', () => {
  const board: LiveBoard = {
    available: true, today: '2026-11-13', sample: false, missing: ['a recent count'],
    orders: [
      {
        supplierId: 's1', supplier: 'Sample brewery', cutoff: '2026-11-16', cutoffTime: '12:00', delivery: '2026-11-17', coversThrough: '2026-11-19',
        deadline: 'Order by Mon, Nov 16, 12:00pm. Tuesday’s delivery lasts until Thursday’s.', lines: [line({ itemId: 'keg', recommended: 0 })],
      },
      {
        supplierId: 's2', supplier: 'Sample distributor', cutoff: '2026-11-18', cutoffTime: '14:00', delivery: '2026-11-19', coversThrough: '2026-11-23',
        deadline: 'Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.',
        lines: [line({ itemId: 'lager', recommended: 6 }), line({ itemId: 'seltzer', recommended: 3 })],
      },
    ],
  };
  // The brewery's keg is due first and comes out at 0; the distributor's 2 items are a later order's.
  expect(barOrderWords(board)).toEqual({
    title: '0 items to order from Sample brewery',
    lines: [
      'Order by Mon, Nov 16, 12:00pm. Tuesday’s delivery lasts until Thursday’s.',
      'The soonest of 2 orders, one per supplier. Orders lists them all.',
      'Townwise still can’t see a recent count.',
    ],
    setUp: true,
  });
  const [brewery, distributor] = board.orders;
  if (brewery === undefined || distributor === undefined) throw new Error('two orders');
  expect(barOrderWords({ ...board, missing: [], orders: [distributor, brewery] })).toEqual({
    title: '2 items to order from Sample distributor',
    lines: ['Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.', 'The soonest of 2 orders, one per supplier. Orders lists them all.'],
    setUp: true,
  });
  expect(barOrderWords({ ...board, orders: [{ ...distributor, lines: [line({ itemId: 'lager', recommended: 6 })] }] }).title).toBe('1 item to order from Sample distributor');
  const unset = barOrderWords({ available: false, today: '2026-11-13', reason: 'No setup.', missing: ['the supplier schedule', 'the items'] });
  expect(unset).toEqual({
    title: 'Ordering isn’t set up yet', lines: ['Townwise still needs the supplier schedule and the items to build an order.'], setUp: false,
  });
  for (const words of [barOrderWords(board), unset]) {
    for (const text of [words.title, ...words.lines]) {
      expect(text).not.toMatch(FORECAST_WORDING);
      expect(text).not.toMatch(/Planned|can’t see your stock/);
    }
  }
});
