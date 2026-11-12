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
  expect(await screen.findByText(/The whole file is sent to Anthropic’s Claude to read\./)).toBeTruthy();
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
