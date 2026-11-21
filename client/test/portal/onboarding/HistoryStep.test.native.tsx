jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { STEP } from '../../../src/portal/onboarding/history';
import type { MeResponse } from '../../../src/portal/schemas';
import { ACCESS, fakePortalApi, locationOf, meOf, orgOf, refusal, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, historyBody } from '../analytics/fakes';
import { NOVEMBER } from '../estimates/fakes';
import { fileViewOf, filesFake, importViewOf } from '../files/fakes';

// Onboarding step 3 on native (D20, D21): no upload and no drop, so the step says where to drop files, keeps
// what to drop in and the location card, and shows a running import's status in words (no calendar). Pillars: the
// reasons for kept files and "Estimating" show here too (T, E); nothing is uploaded from a phone (P).

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 5, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

const PATH = '/api/org/locations/l1';
const EMPTY = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })];

function portal(me: MeResponse, current: unknown): FakePortalApi {
  const analytics = analyticsFake({
    [`${PATH}/sales/history`]: historyBody([]),
    [`${PATH}/notes`]: { notes: [] },
    [`${PATH}/calendar?from=2024-10-07&to=2026-11-30`]: calendarBody(),
    [`${PATH}/agent`]: { questions: [], activity: [] },
    [`${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`]: NOVEMBER,
  });
  const files = filesFake({ inner: analytics });
  files.current = current;
  return fakePortalApi({ me, org: orgOf('org_admin', EMPTY), fallback: files });
}

test('no drop on a phone: the step says where to drop files, with what to drop in and the location card', async () => {
  const api = portal(meOf(ACCESS.admin), { import: null });
  await renderApp('/locations/l1', api);
  expect(await screen.findByText(STEP.nativeDrop)).toBeTruthy();
  expect(screen.getByRole('heading', { name: STEP.title })).toBeTruthy();
  expect(screen.getByText('Daily sales summaries')).toBeTruthy();
  // One location: the card names the organization (D29).
  expect(screen.getByRole('heading', { name: 'Test Group' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: STEP.choose })).toBeNull();
  expect(screen.queryByRole('button', { name: STEP.read })).toBeNull();
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('no drop on a phone, so no TownwiseAI opt-in either (D34)', async () => {
  const api = portal(meOf(ACCESS.admin), { import: null });
  await renderApp('/locations/l1', api);
  expect(await screen.findByText(STEP.nativeDrop)).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: 'Let TownwiseAI read these files and use what it finds' })).toBeNull();
  expect(screen.queryByText('Let TownwiseAI read these files and use what it finds')).toBeNull();
});

test('a running import shows in words: each file’s line, the reasons, and found so far', async () => {
  const view = importViewOf('i1', {
    status: 'reading', startedAt: '2026-11-05T17:00:00.000Z',
    progress: { filesTotal: 2, filesDone: 1, bytesTotal: 20, bytesDone: 10 },
    files: [
      fileViewOf('f1', { name: 'notes.docx', kind: 'docx', status: 'kept', outcome: 'word_no_table', result: null }),
      fileViewOf('f2', { name: 'sales.csv', status: 'reading', result: null, etaSeconds: null }),
    ],
  });
  await renderApp('/locations/l1', portal(meOf(ACCESS.admin), { import: view }));
  expect(await screen.findByRole('heading', { name: STEP.readingTitle })).toBeTruthy();
  expect(screen.getByText('1 of 2 files read · Estimating')).toBeTruthy();
  expect(screen.getByText('Kept, not used: this Word file has no table with dates and sales.')).toBeTruthy();
  expect(screen.getByText('Reading · Estimating')).toBeTruthy();
  expect(screen.getByText('No days yet.')).toBeTruthy();
});

test('a long upload scrolls in its own box: every file listed, the list capped at about 8 rows', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `sales_${String(i + 1).padStart(2, '0')}.csv`);
  const view = importViewOf('i1', {
    status: 'reading', startedAt: '2026-11-05T17:00:00.000Z',
    progress: { filesTotal: 12, filesDone: 0, bytesTotal: 120, bytesDone: 0 },
    files: names.map((name, i) => fileViewOf(`f${String(i + 1)}`, { name, status: 'queued', result: null, etaSeconds: null, queuePosition: i + 1 })),
  });
  await renderApp('/locations/l1', portal(meOf(ACCESS.admin), { import: view }));
  expect(await screen.findByRole('heading', { name: STEP.readingTitle })).toBeTruthy();
  for (const name of names) expect(screen.getByText(name)).toBeTruthy();
  const scroll = screen.getByTestId('history-files-scroll');
  expect(StyleSheet.flatten(scroll.props.style as Parameters<typeof StyleSheet.flatten>[0])).toMatchObject({ maxHeight: 640 });
});

test('stored files off: the step says where to upload instead', async () => {
  await renderApp('/locations/l1', portal(meOf(ACCESS.admin), refusal(503, 'files_unavailable')));
  expect(await screen.findByRole('heading', { name: STEP.offTitle })).toBeTruthy();
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();
});
