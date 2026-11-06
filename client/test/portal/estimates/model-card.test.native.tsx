import { fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../../../src/api/client';
import { ModelCard } from '../../../src/portal/estimates/ModelCard';
import { ACCESS, meOf } from '../../helpers/portal';
import { analyticsFake } from '../analytics/fakes';
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
  expect(screen.getByText('Each day and week is a range that about 8 in 10 days should land inside.')).toBeTruthy();
  expect(screen.getByText('Its ranges were widened after they ran narrow in backtests.')).toBeTruthy();
  expect(screen.getByText('In backtests from Jan 5, 2026 to Mar 15, 2026, a typical week was off by 9.5%, and 1 of 10 weeks missed by more than 20%.')).toBeTruthy();
  expect(screen.getByText('So far: 7 of 9 days inside the range; typical miss 14.3%, from Nov 1, 2026 to Nov 4, 2026.')).toBeTruthy();
  expect(screen.queryByText('In progress')).toBeNull();
  expect(screen.queryByText(/no forecast for/)).toBeNull();
});

test('U13B: a run with too few days passed says it isn’t scored yet, and a run without a backtest leaves it out', async () => {
  await show({ ...ABOUT, forecast: { run: { ...RUN, backtest: null, interval: { level: 0.8, widened: false } }, live: null } });
  expect(await screen.findByText('Not scored yet: Townwise scores it once 5 of its days have sales.')).toBeTruthy();
  expect(screen.queryByText(/In backtests/)).toBeNull();
  expect(screen.queryByText(/widened/)).toBeNull();
});

test('a failed read shows the error with Try again, which reads again', async () => {
  const api = await show(new ApiError('network', 'offline'));
  const retry = await screen.findByRole('button', { name: 'Try again' });
  api.answers[ABOUT_PATH] = ABOUT;
  await fireEvent.press(retry);
  expect(await screen.findByText('In progress')).toBeTruthy();
  expect(api.paths).toEqual([ABOUT_PATH, ABOUT_PATH]);
});
