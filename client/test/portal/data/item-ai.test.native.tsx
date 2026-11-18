jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen } from 'expo-router/testing-library';

import type { DataItem } from '../../../src/portal/data/api';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake } from '../locations/fakes';
import { aiOf, dataFake, itemOf } from './fakes';

// The TownwiseAI section of an item's page on native (P27, D34): the same section as on web, though the file itself
// opens only on the web. Asking for a read, a read running, and a done read's lines.

afterEach(async () => {
  await cleanup();
});

const FILE = `f_${'b'.repeat(24)}`;

function setup(extra: Partial<DataItem>) {
  const fake = dataFake({ inner: locationsFake(), items: [itemOf(FILE, { name: 'june-events.pdf', kind: 'pdf', state: 'kept', outcome: 'reference', ...extra })] });
  return { fake, api: fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake }) };
}

test('a stored file not read yet offers the read, with what it sends, and asks for it', async () => {
  const { api, fake } = setup({ canAiRead: true });
  await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText(/The whole file is sent to Anthropic’s Claude to read \(a picture without its metadata\)\./)).toBeTruthy();
  expect(screen.getByText('Open this file from a computer at townwise.tech.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Let TownwiseAI read this file' }));
  expect(await screen.findByText('TownwiseAI is reading this file. It’s next in line, and this page updates when it’s done.')).toBeTruthy();
  expect(fake.ai).toEqual([{ method: 'POST', ref: FILE, body: {} }]);
});

test('a read running says so, with no button', async () => {
  const { api } = setup({ ai: aiOf({ status: 'reading', kind: null }) });
  await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText('TownwiseAI is reading this file. This can take a few minutes, and this page updates when it’s done.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Let TownwiseAI read this file' })).toBeNull();
});

test('a done read says what it found and added, with Undo for the person who may', async () => {
  const { api } = setup({
    ai: aiOf({ kind: 'calendar', summary: 'Events in June.', daysReason: 'not_sales', itemReason: 'no_summary', calibration: { status: 'not_needed', id: null }, canUndo: true }),
  });
  await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText('TownwiseAI read this file as a calendar of events.')).toBeTruthy();
  expect(screen.getByText('Events in June.')).toBeTruthy();
  expect(screen.getByText('It added no sales days: this isn’t a sales file.')).toBeTruthy();
  expect(screen.getByText('It kept no summary: it found nothing to summarize.')).toBeTruthy();
  expect(screen.getByText('The forecast wasn’t updated: TownwiseAI added no notes or days.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Undo what TownwiseAI added' })).toBeTruthy();
});

test('a read whose days were all there already, and one that stopped part way, say so in plain words', async () => {
  const { api } = setup({ ai: aiOf({ kind: 'sales', daysReason: 'already_had_days', daysAlreadyHad: 4, daysCut: true }) });
  await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText('It added no sales days: you already have every day it found, and TownwiseAI never changes a day you already have.')).toBeTruthy();
  expect(screen.getByText('This file has daily totals for more dates than TownwiseAI reads at once, so it read the newest 1,500 of them.')).toBeTruthy();
  await cleanup();
  const stopped = setup({ canAiRead: true, ai: aiOf({ status: 'skipped', reason: 'requester_gone', kind: null, canUndo: true }) });
  await renderApp(`/locations/l1/data/${FILE}`, stopped.api);
  expect(await screen.findByText('TownwiseAI added nothing from this file: the person who asked is no longer on your team.')).toBeTruthy();
  expect(screen.getByText('TownwiseAI stopped before it finished, and may have added some notes, days or a summary first. You can undo what it added.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Undo what TownwiseAI added' })).toBeTruthy();
});

// D49 (calendar-detail): a calendar file's read shows its events by month, each that made a note linked to its day.
test('a calendar read lists its events by month, marked Note made or No note made', async () => {
  const { api } = setup({
    ai: aiOf({
      kind: 'calendar', notes: [{ id: 'n1', title: 'Rehearsal dinner', startDate: '2026-12-12', endDate: '2026-12-12' }],
      events: [
        { title: 'Rehearsal dinner', startDate: '2026-12-12', endDate: '2026-12-12', kind: 'private_event', effect: 'closed', expectedGuests: 60, noteId: 'n1' },
        { title: 'Staff party', startDate: '2026-12-03', endDate: '2026-12-03', kind: 'other', effect: 'unknown', expectedGuests: null, noteId: null },
      ],
    }),
  });
  const { router } = await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText('December 2026')).toBeTruthy();
  expect(screen.getByText('No note made')).toBeTruthy();
  const made = screen.getByRole('link', { name: 'Rehearsal dinner, Sat, Dec 12, 2026. Opens the day on the Calendar. Note made.' });
  await fireEvent.press(made);
  expect(router.getPathname()).toBe('/locations/l1/calendar');
});
