jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import { act, cleanup as cleanupApp, screen as appScreen } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import { ModelCard } from '../../../src/portal/estimates/ModelCard';
import type { LocationSummary } from '../../../src/portal/schemas';
import { ACCESS, fakePortalApi, LOCATIONS, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, historyBody, run } from '../analytics/fakes';
import { portalWrapper } from '../files/harness';
import { ABOUT, ABOUT_PATH, LOCATION_ID } from './fakes';

// "How Townwise estimates" on native (spec 13.2): with no forecast it says so with an In progress tag and what Home
// and TownwiseAI use instead, lists what the estimates read and can't see, today in the town's time zone, how far the
// town's calendar is researched, and that a headcount is Planned while no public count is researched. U13B: with a
// published run it names the model, its training range and made-at date, its backtest, and how it has done so far,
// misses included, and drops the In progress tag.

async function show(answer: unknown): Promise<ReturnType<typeof analyticsFake>> {
  const api = analyticsFake({ [ABOUT_PATH]: answer });
  const Wrapper = portalWrapper(api, meOf(ACCESS.member));
  await render(<Wrapper><ModelCard locationId={LOCATION_ID} /></Wrapper>);
  return api;
}

test('the no-forecast state: In progress, what is used instead, and every section of the card', async () => {
  await show(ABOUT);
  expect(await screen.findByText('Townwise has no forecast for Test Taproom yet. Home and TownwiseAI use your history and Hanover’s calendar until it does.')).toBeTruthy();
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'How Townwise estimates' })).toBeTruthy();
  for (const term of ['What it estimates', 'What it reads', 'What it can’t see', 'Known limits', 'How it’s checked', 'Who can see the model', 'Hanover today', 'People in town']) {
    expect(screen.getByText(term)).toBeTruthy();
  }
  for (const line of [...ABOUT.card.inputs, ...ABOUT.card.cannotSee, ...ABOUT.card.limits, ABOUT.card.checked, ABOUT.card.whoCanSee]) {
    expect(screen.getByText(line)).toBeTruthy();
  }
  expect(screen.getByText('Thu, Nov 5, 2026, in America/New_York.')).toBeTruthy();
  expect(screen.getByText('Hanover’s calendar is researched from Jan 6, 2025 to Jan 5, 2027, each date with its source.')).toBeTruthy();
  expect(screen.getByText('No public count of how many people are in Hanover is researched yet, so Townwise shows no headcount.')).toBeTruthy();
  expect(screen.getByText('Planned')).toBeTruthy();
  expect(screen.getByText('A headcount from public counts is planned.')).toBeTruthy();
});

test('a town with no researched calendar says holidays only; researched counts drop the Planned tag; an approximate zone says so', async () => {
  await show({
    ...ABOUT,
    location: { name: 'Elsewhere Bar', town: { name: 'Bend', state: 'OR' } },
    today: { date: '2026-11-05', weekday: 'Thu', timeZone: 'America/Los_Angeles', approximate: true },
    calendar: { researched: false, covers: null },
    people: {
      headcountInputs: ['residents'],
      sources: [{ id: 'census-test', label: 'Synthetic census', url: 'https://census.example.test/p1', confidence: 'high' }],
    },
  });
  expect(await screen.findByText('Townwise hasn’t researched Bend’s calendar yet, so it shows US federal holidays only.')).toBeTruthy();
  expect(screen.getByText('Thu, Nov 5, 2026, in America/Los_Angeles (the state’s main time zone; yours may differ).')).toBeTruthy();
  expect(screen.getByText('1 of the public counts behind a headcount are researched for Bend, from 1 source.')).toBeTruthy();
  expect(screen.queryByText('Planned')).toBeNull();
});

const RUN = {
  id: '000000000000000000000010', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
  trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-10-21', madeAt: '2026-11-01', frozen: true,
  interval: { level: 0.8, widened: true },
  backtest: { from: '2026-01-05', to: '2026-03-15', weeks: 10, weeklyTypicalErrorPct: 9.5, weeksOver20Pct: 1 },
} as const;

test('U13B: a published run names its model, sales, dates and backtest, with no In progress tag', async () => {
  await show({ ...ABOUT, forecast: { run: RUN, live: { days: 9, inRange: 7, typicalErrorPct: 14.25, from: '2026-11-01', to: '2026-11-04' } } });
  expect(await screen.findByText('Forecast: Townwise demand model v9, trained on sales exports you sent Townwise from Jan 1, 2025 to Oct 21, 2026, made Nov 1, 2026. It saw no sales after Oct 21, 2026.')).toBeTruthy();
  expect(screen.getByText('Each day and week of the first 3 months is a range that about 8 in 10 days should land inside; the outlook’s ranges are wider on purpose.')).toBeTruthy();
  expect(screen.getByText('Its ranges were widened after they ran narrow in backtests.')).toBeTruthy();
  expect(screen.getByText('In backtests from Jan 5, 2026 to Mar 15, 2026, a typical week was off by 9.5%, and 1 of 10 weeks missed by more than 20%.')).toBeTruthy();
  expect(screen.getByText('So far: 7 of 9 days inside the forecast range; typical miss 14.3%, from Nov 1, 2026 to Nov 4, 2026.')).toBeTruthy();
  expect(screen.queryByText('In progress')).toBeNull();
  expect(screen.queryByText(/no forecast for/)).toBeNull();
});

test('U13B: a run with too few days passed says it isn’t scored yet, and a run without a backtest leaves it out', async () => {
  await show({ ...ABOUT, forecast: { run: { ...RUN, backtest: null, interval: { level: 0.8, widened: false } }, live: null } });
  expect(await screen.findByText('Not scored yet: Townwise scores it once 5 of its days have sales.')).toBeTruthy();
  expect(screen.queryByText(/In backtests/)).toBeNull();
  expect(screen.queryByText(/widened/)).toBeNull();
});

const BASELINE = {
  ...RUN, model: { family: 'seasonal_baseline', version: 'v7', label: 'Townwise\'s baseline from your recent weeks and the town calendar' }, engine: 'baseline',
  trainingSource: 'townwise_lab', interval: { level: 0.8, widened: false },
} as const;

test('D42: a baseline run is named as the baseline, built from the sales and not trained, and says what it is', async () => {
  await show({ ...ABOUT, forecast: { run: BASELINE, live: { days: 6, inRange: 5, typicalErrorPct: 11.6, from: '2026-10-22', to: '2026-11-04' } } });
  expect(await screen.findByText('Forecast: Townwise\'s baseline from your recent weeks and the town calendar, built from sales history and notes you uploaded to Townwise from Jan 1, 2025 to Oct 21, 2026, made Nov 1, 2026. It saw no sales after Oct 21, 2026.')).toBeTruthy();
  expect(screen.getByText('A baseline, not Townwise’s trained demand model: each day is its weekday’s recent level, times last year’s seasonal shape and the town calendar’s effects.')).toBeTruthy();
  expect(screen.queryByText(/trained on/)).toBeNull();
  // Its backtest and its accuracy so far, as any run's.
  expect(screen.getByText(/^In backtests from Jan 5, 2026 to Mar 15, 2026/)).toBeTruthy();
  expect(screen.getByText('So far: 5 of 6 days inside the forecast range; typical miss 11.6%, from Oct 22, 2026 to Nov 4, 2026.')).toBeTruthy();
});

test('D42: a run from an API before engines, or a model run, keeps the model’s words', async () => {
  await show({ ...ABOUT, forecast: { run: { ...RUN, engine: 'model' }, live: null } });
  expect(await screen.findByText(/^Forecast: Townwise demand model v9, trained on /)).toBeTruthy();
  expect(screen.queryByText(/^A baseline/)).toBeNull();
});

test('a failed read shows the error with Try again, which reads again', async () => {
  const api = await show(new ApiError('network', 'offline'));
  const retry = await screen.findByRole('button', { name: 'Try again' });
  api.answers[ABOUT_PATH] = ABOUT;
  await fireEvent.press(retry);
  expect(await screen.findByText('In progress')).toBeTruthy();
  expect(api.paths).toEqual([ABOUT_PATH, ABOUT_PATH]);
});

describe('the no-forecast line on a location page (D29)', () => {
  const PATH = '/api/org/locations/l1';

  afterEach(async () => {
    await cleanupApp();
  });

  async function onAnalytics(locations = LOCATIONS): Promise<void> {
    const days = run('2026-10-01', '2026-10-31', () => 100);
    const fake = analyticsFake({
      [`${PATH}/sales/history`]: historyBody(days),
      [`${PATH}/notes`]: { notes: [] },
      [`${PATH}/calendar?from=2026-01-01&to=2026-12-31`]: calendarBody(),
      [`${PATH}/estimates/about`]: ABOUT,
    });
    await renderApp('/locations/l1/analytics', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', locations), fallback: fake }));
  }

  test('with one location it names the organization', async () => {
    await onAnalytics(LOCATIONS.slice(0, 1));
    expect(await appScreen.findByText('Townwise has no forecast for Test Group yet. Home and TownwiseAI use your history and Hanover’s calendar until it does.')).toBeTruthy();
  });

  test('with several it names the location, as the API does', async () => {
    await onAnalytics();
    expect(await appScreen.findByText('Townwise has no forecast for Test Taproom yet. Home and TownwiseAI use your history and Hanover’s calendar until it does.')).toBeTruthy();
  });
});

describe('the calibration state on a location page (D42: calibrated and stale)', () => {
  const PATH = '/api/org/locations/l1';
  const SALES = { dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-11-21' };

  afterEach(async () => {
    await cleanupApp();
  });

  async function withState(calibration: LocationSummary['calibration']): Promise<void> {
    const [first, ...rest] = LOCATIONS;
    if (first === undefined) throw new Error('no location');
    const fake = analyticsFake({
      [`${PATH}/sales/history`]: historyBody(run('2026-10-01', '2026-10-31', () => 100)),
      [`${PATH}/notes`]: { notes: [] },
      [`${PATH}/calendar?from=2026-01-01&to=2026-12-31`]: calendarBody(),
      [`${PATH}/estimates/about`]: { ...ABOUT, forecast: { run: RUN, live: null } },
    });
    const locations = [{ ...first, calibration }, ...rest];
    await renderApp('/locations/l1/analytics', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', locations), fallback: fake }));
    await appScreen.findByText(/^Forecast: Townwise demand model v9/);
  }

  test('stale with a next refresh: when Townwise refits and with how many days', async () => {
    await withState({ state: 'stale', ...SALES, dataThrough: '2026-11-15', newerDays: 6, nextRefresh: '2026-11-23' });
    expect(appScreen.getByText('Forecast made from your sales through Sun, Nov 15. Townwise refits on Mon, Nov 23 with the 6 days since.')).toBeTruthy();
  });

  test('stale with the refresh off: the days since aren’t in it yet, one day said singly', async () => {
    await withState({ state: 'stale', ...SALES, dataThrough: '2026-11-15', newerDays: 6, nextRefresh: null });
    expect(appScreen.getByText('Forecast made from your sales through Sun, Nov 15. The 6 days since aren’t in it yet.')).toBeTruthy();
    await cleanupApp();
    await withState({ state: 'stale', ...SALES, dataThrough: '2026-11-20', newerDays: 1, nextRefresh: null });
    expect(appScreen.getByText('Forecast made from your sales through Fri, Nov 20. The 1 day since isn’t in it yet.')).toBeTruthy();
  });

  test('calibrated: the run’s own line says what it saw, and no line about days since', async () => {
    await withState({ state: 'calibrated', ...SALES, dataThrough: '2026-11-21', newerDays: 0, nextRefresh: '2026-11-23' });
    expect(appScreen.queryByText(/^Forecast made from your sales/)).toBeNull();
    expect(appScreen.queryByText(/days? since/)).toBeNull();
  });
});

describe('D65: a forecast being updated, on a location page', () => {
  const PATH = '/api/org/locations/l1';
  const SALES = { dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-11-21' };
  // Today at 2:14 PM local, so the line states the time alone.
  const today = new Date();
  today.setHours(14, 14, 0, 0);
  const since = today.toISOString();

  afterEach(async () => {
    await cleanupApp();
    jest.useRealTimers();
  });

  async function withState(calibration: LocationSummary['calibration'], about: unknown = { ...ABOUT, forecast: { run: RUN, live: null } }) {
    const [first, ...rest] = LOCATIONS;
    if (first === undefined) throw new Error('no location');
    const fake = analyticsFake({
      [`${PATH}/sales/history`]: historyBody(run('2026-10-01', '2026-10-31', () => 100)),
      [`${PATH}/notes`]: { notes: [] },
      [`${PATH}/calendar?from=2026-01-01&to=2026-12-31`]: calendarBody(),
      [`${PATH}/estimates/about`]: about,
    });
    const locations = [{ ...first, calibration }, ...rest];
    const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', locations), fallback: fake });
    await renderApp('/locations/l1/analytics', api);
    return { api, fake, first, rest };
  }

  test('a refit running: its new days and start time, linked to the runs in TownwiseAI’s activity', async () => {
    await withState({ state: 'stale', ...SALES, dataThrough: '2026-11-15', newerDays: 6, nextRefresh: '2026-11-23', updating: { stage: 'running', since } });
    const link = await appScreen.findByRole('link', { name: 'Updating your forecast with 6 new days, started 2:14 PM.' });
    expect(link.props.href).toBe('/locations/l1/agent?panel=activity');
    // Beside the stale line, which still says what the published forecast saw, but not that the refit is next Monday.
    expect(appScreen.getByText('Forecast made from your sales through Sun, Nov 15. The 6 days since aren’t in it yet.')).toBeTruthy();
    expect(appScreen.queryByText(/Townwise refits on/)).toBeNull();
  });

  test('a first forecast building and next, in the In progress block', async () => {
    const noRun = ABOUT;
    await withState({ state: 'not_calibrated', ...SALES, updating: { stage: 'running', since }, lastRun: null }, noRun);
    expect(await appScreen.findByRole('link', { name: 'Building your first forecast from 400 days, started 2:14 PM.' })).toBeTruthy();
    expect(appScreen.getByText('In progress')).toBeTruthy();
    await cleanupApp();
    await withState({ state: 'not_calibrated', ...SALES, updating: { stage: 'waiting', since }, lastRun: null }, noRun);
    // Plain words, not a link: TownwiseAI's activity has no run of it yet (design decision 4).
    expect(await appScreen.findByText('Your first forecast is next. Townwise starts building it soon.')).toBeTruthy();
    expect(appScreen.queryByRole('link', { name: 'Your first forecast is next. Townwise starts building it soon.' })).toBeNull();
  });

  test('nothing updating, or an API from before D65: no line', async () => {
    await withState({ state: 'calibrated', ...SALES, dataThrough: '2026-11-21', newerDays: 0, nextRefresh: '2026-11-23' });
    await appScreen.findByText(/^Forecast: Townwise demand model v9/);
    expect(appScreen.queryByText(/^(Updating|Building) your/)).toBeNull();
  });

  test('when the update ends, the card reads its estimates again in place, with no loading line', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
    const { api, fake, first, rest } = await withState(
      { state: 'not_calibrated', ...SALES, updating: { stage: 'running', since }, lastRun: null }, ABOUT,
    );
    await appScreen.findByRole('link', { name: 'Building your first forecast from 400 days, started 2:14 PM.' });
    const reads = (): number => fake.paths.filter((path) => path === `${PATH}/estimates/about`).length;
    expect(reads()).toBe(1);
    // The run publishes: the next re-read of the organization finds it, and the card reads the published run.
    api.org = orgOf('member', [{ ...first, calibration: { state: 'calibrated', ...SALES, dataThrough: '2026-11-21', newerDays: 0, nextRefresh: '2026-11-23', updating: null } }, ...rest]);
    fake.answers[`${PATH}/estimates/about`] = { ...ABOUT, forecast: { run: RUN, live: null } };
    await act(() => jest.advanceTimersByTimeAsync(30_000));
    expect(await appScreen.findByText(/^Forecast: Townwise demand model v9/)).toBeTruthy();
    expect(reads()).toBe(2);
    expect(appScreen.queryByText('Loading how Townwise estimates…')).toBeNull();
    expect(appScreen.queryByText(/^Building your first/)).toBeNull();
  });
});
