import { fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../../../src/api/client';
import { ModelCard } from '../../../src/portal/estimates/ModelCard';
import { ACCESS, meOf } from '../../helpers/portal';
import { analyticsFake } from '../analytics/fakes';
import { portalWrapper } from '../files/harness';
import { ABOUT, ABOUT_PATH, LOCATION_ID } from './fakes';

// "How Townwise estimates" on native (spec 13.2): with no forecast it says so with an In progress tag and what Home
// and TownwiseAI use instead, lists what the estimates read and can't see, today in the town's time zone, how far the
// town's calendar is researched, and that a headcount is Planned while no public count is researched.

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

test('a failed read shows the error with Try again, which reads again', async () => {
  const api = await show(new ApiError('network', 'offline'));
  const retry = await screen.findByRole('button', { name: 'Try again' });
  api.answers[ABOUT_PATH] = ABOUT;
  await fireEvent.press(retry);
  expect(await screen.findByText('In progress')).toBeTruthy();
  expect(api.paths).toEqual([ABOUT_PATH, ABOUT_PATH]);
});
