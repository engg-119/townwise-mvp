jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { render } from '@testing-library/react-native';
import { cleanup, renderRouter, screen, within } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import SecurityScreen from '../../../app/(gate)/(app)/(account)/settings/security';
import { AuthProvider } from '../../../src/auth/AuthProvider';
import { AnalyticsSkeleton } from '../../../src/portal/skeleton';
import { ACCESS, fakePortalApi, meOf, orgOf, type FakePortalApi } from '../../helpers/portal';
import { fakeAuth } from '../../helpers/fakes';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake } from '../locations/fakes';

// Each page's loading state on native (spec 15.7 Loading, 16.2, 16.3): the page's skeleton, holding the page's
// loading words as its one status line, in place of the old text line.

afterEach(async () => {
  await cleanup();
});

/** Reads of `path` never answer, so the page stays loading. */
function hang(api: FakePortalApi, path: string): FakePortalApi {
  const json = api.json.bind(api);
  api.json = (at, schema, opts) => ((opts?.method ?? 'GET') === 'GET' && at === path ? new Promise(() => undefined) : json(at, schema, opts));
  return api;
}

/** Every read under the location never answers, so a page that waits for several reads stays loading. */
function hangLocation(api: FakePortalApi): FakePortalApi {
  const json = api.json.bind(api);
  api.json = (at, schema, opts) => ((opts?.method ?? 'GET') === 'GET' && at.startsWith('/api/org/locations/l1/') ? new Promise(() => undefined) : json(at, schema, opts));
  return api;
}

/** The page's skeleton holds the loading words, and they show nowhere else. */
async function expectSkeleton(name: string, words: string): Promise<void> {
  const skeleton = await screen.findByTestId(`skeleton-${name}`);
  expect(within(skeleton).getByRole('status').props.children).toBe(words);
  expect(screen.getAllByText(words)).toHaveLength(1);
}

test('P9 Locations: its skeleton while the organization loads', async () => {
  const api = hang(fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), '/api/org');
  await renderApp('/dashboard', api);
  await expectSkeleton('locations', 'Loading your locations');
  expect(screen.getByRole('heading', { name: 'Locations' })).toBeTruthy();
});

test('P18 Settings: an org admin’s skeleton while the staff activity loads', async () => {
  const api = hang(fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }), '/api/org/staff-activity');
  await renderApp('/settings', api);
  await expectSkeleton('settings', 'Loading your settings');
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
});

test('P17 Team: the list’s skeleton, with the add form already there', async () => {
  const api = hang(fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }), '/api/org/members');
  await renderApp('/team', api);
  await expectSkeleton('team', 'Loading your team');
  expect(screen.getByRole('heading', { name: 'Who can sign in' })).toBeTruthy();
});

test('P14 Notes: its skeleton under the intro', async () => {
  const api = hang(fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: locationsFake() }), '/api/org/locations/l1/notes');
  await renderApp('/locations/l1/notes', api);
  await expectSkeleton('notes', 'Loading notes');
  expect(screen.getByText('Talking to your model is planned.')).toBeTruthy();
});

test('P12 Sales data: its skeleton while the sales load', async () => {
  const api = hang(fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: locationsFake() }), '/api/org/locations/l1/sales');
  await renderApp('/locations/l1/sales', api);
  await expectSkeleton('sales', 'Loading sales data');
});

test('P3 Request access: the form’s skeleton while it asks whether the Google Maps search is on', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  api.answers['/api/places/autocomplete'] = () => new Promise(() => undefined);
  await renderApp('/request-access', api);
  await expectSkeleton('request-access', 'Checking for the Google Maps search…');
  expect(screen.getByRole('heading', { name: 'Joining a team that already uses Townwise?' })).toBeTruthy();
  expect(screen.queryByLabelText('Organization name')).toBeNull();
});

test('P7 Two-step sign-in: its skeleton while it reads whether two-step is on', async () => {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: 'a@example.com' } }, { loadMe: () => new Promise(() => undefined) });
  await renderRouter({ security: SecurityScreen }, {
    initialUrl: '/security',
    wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider auth={auth}>{children}</AuthProvider>,
  });
  await expectSkeleton('security', 'Loading two-step sign-in');
  expect(screen.queryByRole('heading', { name: 'Before you start' })).toBeNull();
});

describe('the location pages', () => {
  const hangLocal = (): FakePortalApi => hangLocation(fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: locationsFake() }));

  test('P11 Home: the lead, the figures, the month grid and Who’s in town', async () => {
    await renderApp('/locations/l1', hangLocal());
    const skeleton = await screen.findByTestId('skeleton-home');
    const words = within(skeleton).getByRole('status').props.children as string;
    expect(words).toMatch(/^Loading \S/);
    expect(screen.getAllByText(words)).toHaveLength(1);
    expect(within(skeleton).getAllByTestId('skeleton-home-month-cell', { hidden: true })).toHaveLength(42);
  });

  test('P28 Calendar: the toolbar, a six-week grid of 42 cells and the day panel', async () => {
    await renderApp('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    expect(screen.getAllByTestId('skeleton-calendar-cell', { hidden: true })).toHaveLength(42);
    expect(screen.getAllByTestId('skeleton-calendar-panel', { hidden: true })).toHaveLength(1);
  });

  test('P28 Calendar: after the view switch the header row holds the Your calendars block, as on web', async () => {
    await renderApp('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    // Native's import line is inside the closed panel now, so the row ends with the button's 170px block.
    const row = screen.getByTestId('skeleton-calendar-row', { hidden: true });
    const calendars = within(row).getByTestId('skeleton-calendar-calendars', { hidden: true });
    expect(StyleSheet.flatten(calendars.props.style)).toEqual(expect.objectContaining({ width: 170, minHeight: 44 }));
    expect(within(row).queryByTestId('skeleton-calendar-import-line', { hidden: true })).toBeNull();
    // In the row's order: the label, the switch, then the button's block.
    const order = within(row).getAllByTestId(/^skeleton-calendar-(label|views|calendars)$/, { hidden: true }).map((item) => item.props.testID as string);
    expect(order).toEqual(['skeleton-calendar-label', 'skeleton-calendar-views', 'skeleton-calendar-calendars']);
  });

  test('P29 Business rules: the add form and a few rows', async () => {
    await renderApp('/locations/l1/rules', hangLocal());
    await expectSkeleton('rules', 'Loading business rules');
    expect(screen.getAllByTestId('skeleton-rules-row', { hidden: true }).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId('skeleton-rules-schedule-button', { hidden: true })).toBeTruthy();
    expect(screen.getByTestId('skeleton-rules-schedule-help', { hidden: true })).toBeTruthy();
  });
});

// The skeleton is checked alone here; Analytics.tsx mounts it while loading.
test('P24 Analytics: the filters, Every day as month rows, and the sections without charts (D21)', async () => {
  await render(<AnalyticsSkeleton label="Loading analytics" />);
  await expectSkeleton('analytics', 'Loading analytics');
  expect(screen.getAllByTestId('skeleton-analytics-filter-group', { hidden: true })).toHaveLength(4);
  expect(screen.getAllByTestId('skeleton-analytics-month', { hidden: true }).length).toBeGreaterThanOrEqual(4);
  // Native draws no chart (D21): each section keeps its summary, its basis line and Show the numbers.
  expect(screen.queryAllByTestId('skeleton-analytics-chart', { hidden: true })).toHaveLength(0);
  expect(screen.queryAllByTestId('skeleton-analytics-bars', { hidden: true })).toHaveLength(0);
  expect(screen.getAllByTestId('skeleton-analytics-drivers', { hidden: true })).toHaveLength(1);
});
