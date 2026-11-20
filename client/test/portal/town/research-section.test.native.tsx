jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { act, cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import { addDays, localToday } from '../../../src/portal/locations/dates';
import { resetProfiles } from '../../../src/portal/profile/useProfile';
import { researchSeenKey } from '../../../src/portal/research/seen';
import { pressOpensLine, RESEARCH_NOW, RESTORE_NOTICES, switchWords, WEEK_OFF } from '../../../src/portal/town/research-copy';
import {
  ACCESS, fakePortalApi, meOf, openAsAdminMe, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { withRoutes } from '../team/fixtures';

// P15's Research section (D66 design decision 15, task 7.3): status in topics, gaps, Research now (org admins only,
// never under view-as or open as admin; 409 and 429 in words), the research switch (org admins outside view-as; staff
// open as admin only while on), coming up this week, who and where, Hidden by your team with Restore sending the
// item's head, and the poll with useWhileRunning while a run is live, re-reading the organization when it ends.
// Made-up titles and places only.

const BASE = '/api/org/locations/l1';
const HEX = 'a'.repeat(24);
const COUNTS = { found: 9, added: 3, updated: 1, dropped: 0 };
const SIX = ['schools', 'sports', 'arts_festivals', 'civic', 'tourism_seasonal', 'markets_community'];

function found(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `t-${'b'.repeat(24)}`, head: 'base', title: 'Winter carnival', start: localToday(), end: localToday(), weekdays: null, startTime: null,
    kind: 'event', category: 'festival', status: 'scheduled', origin: 'town', confidence: 'low', where: 'Example Green', who: null,
    competitor: null, sources: [{ label: 'example.com', url: 'https://example.com/carnival' }], lastSeenAt: '2026-11-18T12:00:00.000Z',
    edited: false, hidden: false, ...fields,
  };
}

function townRun(status: string, done: number): Record<string, unknown> {
  return {
    status, finishedAt: status === 'running' ? null : '2026-11-17T15:00:00.000Z', counts: COUNTS,
    threads: SIX.map((thread, i) => ({ thread, status: i < done ? 'recorded' : 'running', code: null })),
  };
}

function locationRun(status: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const live = ['queued', 'running', 'merging'].includes(status);
  return {
    id: 'run-1', status, finishedAt: live ? null : '2026-11-17T16:00:00.000Z', counts: COUNTS, trigger: 'weekly', startedAt: '2026-11-17T15:30:00.000Z',
    threads: [
      { thread: 'neighborhood', status: live ? 'queued' : 'recorded', code: live ? 'overloaded' : null },
      { thread: 'competitors', status: live ? 'running' : 'recorded', code: null },
    ],
    ...fields,
  };
}

function research(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    on: true, available: true, town: townRun('done', 6), location: locationRun('done'), next: '2026-11-23', pressAt: null, gaps: [],
    entities: [{ id: 'e1', type: 'venue', name: 'Example Hall', events: 2 }],
    hidden: [{ id: `l-${HEX}`, title: 'Quiz night', start: '2026-12-03', end: '2026-12-03', head: 'r1' }],
    ...fields,
  };
}

const COMPETITION = { gap: null, map: null, competitors: [], web: [] };

interface Setup { api: FakePortalApi; body: { research: Record<string, unknown> } }

function setup(opts: {
  me?: ReturnType<typeof meOf>; role?: 'org_admin' | 'member'; research?: Record<string, unknown>; found?: Record<string, unknown>[];
} = {}): Setup {
  const role = opts.role ?? 'org_admin';
  const api = fakePortalApi({ me: opts.me ?? meOf(role === 'org_admin' ? ACCESS.admin : ACCESS.member), org: orgOf(role) });
  const body = { research: opts.research ?? research() };
  const from = localToday();
  withRoutes(api, {
    gets: {
      [`${BASE}/research`]: () => body.research,
      [`${BASE}/calendar?from=${from}&to=${addDays(from, 6)}`]: () => ({
        town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, researched: true, covers: null, events: [], found: opts.found ?? [found()],
      }),
      [`${BASE}/competition?theme=dark`]: () => COMPETITION,
      '/api/me/profile': () => ({ displayName: null, askName: false }),
    },
  });
  return { api, body };
}

function gets(api: FakePortalApi, path: string): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === path).length;
}

afterEach(async () => {
  await cleanup();
  resetProfiles();
  jest.useRealTimers();
});

test('an org admin sees both runs in topics, the next run, this week, who and where, hidden, Research now and the switch', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText(/^Hanover: last researched .*, 9 events, 3 new$/)).toBeTruthy();
  expect(screen.getByText(/^Your restaurant and nearby: last researched .*, 9 events, 3 new$/)).toBeTruthy();
  expect(screen.getByText('Schools and college: Done')).toBeTruthy();
  expect(screen.getByText('Competitors and their events: Done')).toBeTruthy();
  expect(screen.getByText('Next weekly research: Mon, Nov 23')).toBeTruthy();
  expect(await screen.findByText('Winter carnival')).toBeTruthy();
  expect(screen.getByText(/ · Unconfirmed$/)).toBeTruthy();
  expect(screen.getByText('Example Hall')).toBeTruthy();
  expect(screen.getByText('Venue · 2 upcoming events')).toBeTruthy();
  expect(screen.getByText('Hidden by your team (1)')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore Quiz night' })).toBeTruthy();
  expect(screen.getByRole('button', { name: RESEARCH_NOW })).toBeTruthy();
  expect(screen.getByText(new RegExp(switchWords('Hanover').slice(0, 40)))).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn off town research' })).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('gaps in words: research off for the organization', async () => {
  const { api } = setup({ research: research({ on: false, gaps: ['off', 'budget'], next: null }) });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText('Town research is off for your organization, so nothing new is being found.')).toBeTruthy();
  expect(screen.getByText(/^Little TownwiseAI budget was left this month/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn on town research' })).toBeTruthy();
});

test('Research now posts, then reads the run, and refusals are words', async () => {
  const { api, body } = setup();
  api.answers[`${BASE}/research/run`] = () => {
    body.research = research({ location: locationRun('running', { trigger: 'press' }) });
    return { run: body.research.location };
  };
  await renderApp('/locations/l1/town', api);
  await fireEvent.press(await screen.findByRole('button', { name: RESEARCH_NOW }));
  expect(await screen.findByText('Researching your restaurant and nearby: 0 of 2 topics done')).toBeTruthy();
  expect(screen.getByText('Your restaurant and its neighborhood: Waiting to try again')).toBeTruthy();
  expect(screen.getByText('Research is running. This page updates as it goes.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: `${BASE}/research/run`, body: {} }]);
});

test.each([
  [409, 'too_soon', 'Research ran in the last 6 hours. Try again later.'],
  [429, 'rate_limited', 'You can press Research now 3 times a day. Try again tomorrow.'],
])('Research now refused %i %s says so in words', async (status, code, words) => {
  const { api } = setup();
  api.answers[`${BASE}/research/run`] = () => refusal(status, code, 3600);
  await renderApp('/locations/l1/town', api);
  await fireEvent.press(await screen.findByRole('button', { name: RESEARCH_NOW }));
  expect(await screen.findByText(words)).toBeTruthy();
});

test('members see no Research now and no switch; Restore sends the item’s head', async () => {
  const { api, body } = setup({ role: 'member' });
  api.answers[`${BASE}/research/events/l-${HEX}`] = () => {
    body.research = research({ hidden: [] });
    return { event: found({ id: `l-${HEX}`, head: 'r2' }) };
  };
  await renderApp('/locations/l1/town', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Restore Quiz night' }));
  expect(await screen.findByText(RESTORE_NOTICES.restored)).toBeTruthy();
  await waitFor(() => { expect(screen.queryByText('Hidden by your team (1)')).toBeNull(); });
  expect(writes(api)).toEqual([{ method: 'PATCH', path: `${BASE}/research/events/l-${HEX}`, body: { op: 'restore', basedOn: 'r1' } }]);
  expect(screen.queryByRole('button', { name: RESEARCH_NOW })).toBeNull();
  expect(screen.queryByRole('button', { name: /town research$/ })).toBeNull();
});

test('a Restore someone beat says so and shows the event as it reads now', async () => {
  const { api, body } = setup();
  api.answers[`${BASE}/research/events/l-${HEX}`] = () => {
    body.research = research({ hidden: [{ id: `l-${HEX}`, title: 'Quiz night', start: '2026-12-03', end: '2026-12-03', head: 'r3' }] });
    return refusal(409, 'changed_since');
  };
  await renderApp('/locations/l1/town', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Restore Quiz night' }));
  expect(await screen.findByText(RESTORE_NOTICES.changedSince)).toBeTruthy();
  await waitFor(() => { expect(gets(api, `${BASE}/research`)).toBe(2); });
});

test('view-as: no Research now, no switch, Restore disabled with the read-only line', async () => {
  const { api } = setup({ me: viewAsMe(ACCESS.admin) });
  await renderApp('/locations/l1/town', api);
  const restore = await screen.findByRole('button', { name: 'Restore Quiz night' });
  expect(restore.props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByText(/^Read-only while viewing as /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: RESEARCH_NOW })).toBeNull();
  expect(screen.queryByRole('button', { name: /town research$/ })).toBeNull();
});

test('staff open as admin: no Research now; the switch only while on, to turn it off', async () => {
  const { api } = setup({ me: openAsAdminMe() });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByRole('button', { name: 'Turn off town research' })).toBeTruthy();
  expect(screen.getByText('You can turn this off. Only an admin of this organization can turn it back on.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: RESEARCH_NOW })).toBeNull();
});

test('staff open as admin do not see the switch while it is off', async () => {
  const { api } = setup({ me: openAsAdminMe(), research: research({ on: false, gaps: ['off'] }) });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText('Town research is off for your organization, so nothing new is being found.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /town research$/ })).toBeNull();
});

test('polls while a run is live and, when it ends, re-reads the organization, this week and the competition', async () => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 19, 12, 0, 0),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  });
  const { api, body } = setup({ research: research({ town: townRun('running', 3), location: locationRun('running', { trigger: 'press' }) }) });
  const from = localToday();
  const week = `${BASE}/calendar?from=${from}&to=${addDays(from, 6)}`;
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText('Researching Hanover: 3 of 6 topics done')).toBeTruthy();
  const orgReads = gets(api, '/api/org');
  expect(gets(api, `${BASE}/research`)).toBe(1);
  await act(() => jest.advanceTimersByTimeAsync(30_000));
  expect(gets(api, `${BASE}/research`)).toBe(2);
  expect(gets(api, week)).toBe(1);

  body.research = research();
  await act(() => jest.advanceTimersByTimeAsync(30_000));
  expect(await screen.findByText(/^Hanover: last researched/)).toBeTruthy();
  expect(await screen.findByText('Research finished: 3 new events on your calendar.')).toBeTruthy();
  await waitFor(() => { expect(gets(api, '/api/org')).toBe(orgReads + 1); });
  expect(gets(api, week)).toBe(2);
  expect(gets(api, `${BASE}/competition?theme=dark`)).toBe(2);
  // Nothing live: no more reads.
  await act(() => jest.advanceTimersByTimeAsync(90_000));
  expect(gets(api, `${BASE}/research`)).toBe(3);
});

test('opening the Town tab marks the location’s run seen, so the Calendar’s banner for it clears', async () => {
  const { api } = setup({ research: research({ location: locationRun('done', { trigger: 'press' }) }) });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText(/^Your restaurant and nearby: last researched/)).toBeTruthy();
  await waitFor(() => {
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(researchSeenKey('u1', 'l1'), 'run-1');
  });
});

test('a run pressed and left while queued is not marked seen, so the Calendar still shows its banner (UI review)', async () => {
  jest.mocked(SecureStore.setItemAsync).mockClear();
  const { api } = setup({ research: research({ location: locationRun('queued', { id: 'run-2', trigger: 'press', startedAt: null }) }) });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText('Your restaurant and nearby: Queued')).toBeTruthy();
  await act(() => Promise.resolve());
  expect(jest.mocked(SecureStore.setItemAsync).mock.calls.filter(([key]) => key === researchSeenKey('u1', 'l1'))).toEqual([]);
});

test('turning research off re-reads this week and the competition, and the week reads the off line (UI review)', async () => {
  const { api, body } = setup();
  api.answers['/api/org/research'] = () => {
    body.research = research({ on: false, gaps: ['off'], next: null });
    return { research: { on: false } };
  };
  const from = localToday();
  const week = `${BASE}/calendar?from=${from}&to=${addDays(from, 6)}`;
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText('Winter carnival')).toBeTruthy();
  expect(gets(api, week)).toBe(1);
  expect(gets(api, `${BASE}/competition?theme=dark`)).toBe(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Turn off town research' }));
  expect(await screen.findByText(WEEK_OFF)).toBeTruthy();
  expect(screen.queryByText('Winter carnival')).toBeNull();
  await waitFor(() => { expect(gets(api, week)).toBe(2); });
  expect(gets(api, `${BASE}/competition?theme=dark`)).toBe(2);
  expect(screen.queryByText('Research found nothing for the next 7 days.')).toBeNull();
});

test('within 6 hours of the last run, Research now is disabled and says when it opens, then opens (UI review)', async () => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 19, 12, 0, 0),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  });
  const opens = new Date(2026, 10, 19, 12, 30, 0).toISOString();
  const { api } = setup({ research: research({ pressAt: opens }) });
  await renderApp('/locations/l1/town', api);
  const button = await screen.findByRole('button', { name: RESEARCH_NOW });
  expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByText(pressOpensLine(opens, new Date(2026, 10, 19, 12, 0, 0)))).toBeTruthy();
  await act(() => jest.advanceTimersByTimeAsync(31 * 60_000));
  expect(screen.getByRole('button', { name: RESEARCH_NOW }).props.accessibilityState).toMatchObject({ disabled: false });
  expect(screen.getByText(/^Looks again at your restaurant/)).toBeTruthy();
});

test('coming up this week links a season to a day this week and leaves out a weekly event with no day in it', async () => {
  const today = localToday();
  const lastWeek = addDays(today, -7);
  const { api } = setup({
    found: [
      found({ id: `t-${'c'.repeat(24)}`, title: 'Ski season', kind: 'season', start: '2026-01-01', end: addDays(today, 90) }),
      // Held only on the weekday of the 7th day, and ends the day before it: no day in the next 7.
      found({
        id: `t-${'d'.repeat(24)}`, title: 'Trivia night', start: lastWeek, end: addDays(today, 5),
        weekdays: [(new Date(`${addDays(today, 6)}T00:00:00.000Z`).getUTCDay())],
      }),
    ],
  });
  await renderApp('/locations/l1/town', api);
  expect((await screen.findByRole('link', { name: 'Ski season' })).props.href).toBe(`/locations/l1/calendar?day=${today}`);
  expect(screen.queryByText('Trivia night')).toBeNull();
});
