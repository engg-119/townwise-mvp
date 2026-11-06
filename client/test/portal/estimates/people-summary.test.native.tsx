import { render, screen } from '@testing-library/react-native';

import type { PeopleInTown } from '../../../src/portal/estimates/api';
import { PeopleInTownSummary } from '../../../src/portal/estimates/PeopleInTownSummary';
import { ACCESS, meOf, offline } from '../../helpers/portal';
import { analyticsFake } from '../analytics/fakes';
import { portalWrapper } from '../files/harness';
import { LOCATION_ID, NOVEMBER, PEOPLE_PATH, period } from './fakes';

// People in town for Home's month card on native (spec 13.2): the term periods in words, the honest "can't put a
// number on it" line with Planned when no headcount exists, a range with its source count when one does, the
// location's own history only with both term states, and the source hosts. Synthetic data only.

async function show(answer: unknown): Promise<void> {
  const api = analyticsFake({ [PEOPLE_PATH]: answer });
  const Wrapper = portalWrapper(api, meOf(ACCESS.member));
  await render(<Wrapper><PeopleInTownSummary locationId={LOCATION_ID} month="2026-11" /></Wrapper>);
}

test('without a headcount: the term in words, the can’t-put-a-number line with Planned, and where it came from', async () => {
  await show(NOVEMBER);
  expect(await screen.findByText('Fall term classes until Tue, Nov 17.')).toBeTruthy();
  expect(screen.getByText('Fall term finals Fri, Nov 20 to Wed, Nov 25.')).toBeTruthy();
  expect(screen.getByText('Townwise has no term dates from Thu, Nov 26.')).toBeTruthy();
  expect(screen.getByText('Townwise can’t put a number on how many people are in Hanover yet.')).toBeTruthy();
  expect(screen.getByText('Planned')).toBeTruthy();
  expect(screen.getByText('A headcount from public counts is planned.')).toBeTruthy();
  for (const host of ['registrar.dartmouth.edu', 'opm.gov', 'bls.gov']) expect(screen.getByText(host)).toBeTruthy();
  expect(screen.getByText(/County jobs are 2024\./)).toBeTruthy();
  expect(screen.queryByText(/^Your /)).toBeNull();
});

test('with a headcount: one dated line per run of days with the same range, the rest saying why, and no Planned tag', async () => {
  const range = { low: 9500, high: 10_500, sourceIds: ['census-test', 'cal-1'], excludes: [] };
  const counted: PeopleInTown = {
    ...NOVEMBER,
    periods: [
      period({ from: '2026-11-01', fromWeekday: 'Sun', to: '2026-11-10', toWeekday: 'Tue', headcountWhy: null, headcount: range }),
      period({
        from: '2026-11-11', fromWeekday: 'Wed', to: '2026-11-11', toWeekday: 'Wed', headcountWhy: null, headcount: range,
        events: [{ id: 'us:veterans-day:2026', title: 'Veterans Day', kind: 'holiday', attendanceHigh: null, sourceIds: ['cal-2'] }],
      }),
      period({ from: '2026-11-12', fromWeekday: 'Thu', to: '2026-11-17', toWeekday: 'Tue', headcountWhy: null, headcount: range }),
      period({ from: '2026-11-18', fromWeekday: 'Wed', to: '2026-11-30', toWeekday: 'Mon', termState: 'unknown', termLabel: null, headcountWhy: 'no_term_dates' }),
    ],
    sources: [...NOVEMBER.sources, { id: 'census-test', label: 'Synthetic census', url: 'https://census.example.test/p1', confidence: 'high' }],
  };
  await show(counted);
  expect(await screen.findByText('Fall term classes until Tue, Nov 17. About 9,500 to 10,500 people in town, from 2 sources.')).toBeTruthy();
  expect(screen.getByText('Townwise has no term dates from Wed, Nov 18, so it can’t put a number on how many people are in town.')).toBeTruthy();
  expect(screen.queryByText('Fall term classes until Tue, Nov 17.')).toBeNull();
  expect(screen.queryByText('Planned')).toBeNull();
  expect(screen.getByText('census.example.test')).toBeTruthy();
});

test('the history line and its own provenance appear only when both term states have a mean', async () => {
  await show({
    ...NOVEMBER,
    yourHistory: {
      metric: 'guests',
      cells: [{ state: 'in_session', weekday: 'Sat', days: 18, mean: 250 }, { state: 'between_terms', weekday: 'Sat', days: 6, mean: 140 }],
      first: '2025-01-04', last: '2026-10-31',
    },
  });
  expect(await screen.findByText('Your Saturdays averaged 250 guests in term and 140 between terms (18 and 6 Saturdays).')).toBeTruthy();
  expect(screen.getByText('From your sales, Jan 4, 2025 to Oct 31, 2026, 24 days.')).toBeTruthy();
});

test('a town outside the twelve says Townwise hasn’t researched it', async () => {
  await show({ ...NOVEMBER, available: false, reason: 'town_not_researched', town: { name: 'Woodstock', state: 'VT', kind: null }, season: [] });
  expect(await screen.findByText('Townwise hasn’t researched Woodstock, VT yet.')).toBeTruthy();
  expect(screen.queryByText('Planned')).toBeNull();
});

test('a failed read offers Try again', async () => {
  await show(offline());
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
});
