jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';
import { StyleSheet, type TextStyle } from 'react-native';

import {
  ACCESS, deferred, fakePortalApi, locationOf, LOCATIONS, meOf, offline, orgOf, refusal, viewAsMe, writes,
} from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { theme } from '../../src/theme';

afterEach(async () => {
  await cleanup();
});

test('loading shows one line in place of the list', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member) });
  const org = deferred<unknown>();
  api.org = orgOf('member');
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => (path === '/api/org' ? org.promise.then(() => json(path, schema, opts)) : json(path, schema, opts));
  await renderApp('/dashboard', api);
  expect(await screen.findByText('Loading your locations')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Locations' })).toBeTruthy();
});

test('several locations: one row each, with town, sales history, calibration in words, notes and the next step', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  const { router } = await renderApp('/dashboard', api);
  const table = await screen.findByLabelText('Locations');
  for (const text of [
    'Main Street Bar', 'Hanover, NH', '400 days', 'Jan 1, 2025 to Feb 4, 2026', '2 notes', 'None for now',
    'River Grill', 'Norwich, VT', 'No sales history yet', 'No notes yet', 'Upload from a computer at townwise.tech',
  ]) {
    expect(within(table).getByText(text)).toBeTruthy();
  }
  expect(within(table).getAllByText('Not calibrated yet')).toHaveLength(2);
  // The top bar and the page's eyebrow name the organization.
  expect(screen.getAllByText('Test Group')).toHaveLength(2);
  // Members add no locations.
  expect(screen.queryByRole('link', { name: 'Add location' })).toBeNull();
  await fireEvent.press(within(table).getByText('Main Street Bar'));
  expect(router.getPathname()).toBe('/locations/l1');
});

test('a location with a published forecast says so in its Calibration cell, never “Not calibrated yet”', async () => {
  const history = { dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-11-15' };
  const coverage = { dayCount: 400, guestsDayCount: 400, netSalesDayCount: 400, firstDate: '2025-01-01', lastDate: '2026-11-15', missingDays: 0 };
  const town = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
  const calibrated = locationOf('l7', 'Fresh Cafe', town, {
    coverage, calibration: { state: 'calibrated', ...history, dataThrough: '2026-11-15', newerDays: 0, nextRefresh: '2026-11-23' },
  });
  const stale = locationOf('l8', 'Behind Cafe', town, {
    coverage, calibration: { state: 'stale', ...history, dataThrough: '2026-11-08', newerDays: 7, nextRefresh: '2026-11-23' },
  });
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', [calibrated, stale]) });
  await renderApp('/dashboard', api);
  const table = await screen.findByLabelText('Locations');
  expect(within(table).getByText('Forecast published')).toBeTruthy();
  expect(within(table).getByText('Forecast published, 7 newer days not in it yet')).toBeTruthy();
  expect(within(table).queryByText('Not calibrated yet')).toBeNull();
});

test('a location whose every upload is off says so and links to Your data', async () => {
  const off = locationOf('l9', 'Off Cafe', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, { offDayCount: 10 });
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', [off, LOCATIONS[1] ?? off]) });
  await renderApp('/dashboard', api);
  const table = await screen.findByLabelText('Locations');
  expect(within(table).getByText('Uploads turned off')).toBeTruthy();
  expect(within(table).getByRole('link', { name: 'Open Your data' })).toBeTruthy();
  expect(within(table).queryByText('Upload sales history')).toBeNull();
});

test('a long location name wraps at the type’s line height and keeps a 44px tap target', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  await renderApp('/dashboard', api);
  const table = await screen.findByLabelText('Locations');
  const style: TextStyle = StyleSheet.flatten(within(table).getByText('Main Street Bar').props.style as TextStyle) ?? {};
  expect(style.lineHeight).toBe(theme.type.mono.lineHeight);
  expect(style.minHeight).toBe(44);
  expect((style.lineHeight ?? 0) + 2 * Number(style.paddingVertical)).toBe(44);
});

test('the towns of the locations, from the bundled public data', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  const { router } = await renderApp('/dashboard', api);
  expect(await screen.findByRole('heading', { name: 'Your towns' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Hanover, NH' })).toBeTruthy();
  expect(screen.getByText('College town')).toBeTruthy();
  expect(screen.getByText('Measured across Grafton County, 2025.')).toBeTruthy();
  // Norwich is not one of the twelve, so it has no panel.
  expect(screen.queryByRole('heading', { name: 'Norwich, VT' })).toBeNull();
  await fireEvent.press(screen.getByRole('link', { name: 'Hanover’s town profile' }));
  expect(router.getPathname()).toBe('/locations/l1/town');
});

// BLS withheld Nantucket County for April to June 2025: its panel says why in place of the measured line and the
// pattern, and the research line names no employment pattern.
test('a town whose county BLS did not publish for the year shows the reason, with no pattern', async () => {
  const nantucket = locationOf('l3', 'Harbor Grill', { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' });
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', [nantucket, LOCATIONS[1] ?? nantucket]) });
  await renderApp('/dashboard', api);
  expect(await screen.findByRole('heading', { name: 'Nantucket, MA' })).toBeTruthy();
  expect(screen.getByText('BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.')).toBeTruthy();
  expect(screen.getByText('No 2025 jobs index. Drivers aren’t researched yet.')).toBeTruthy();
  expect(screen.queryByText(/^Measured across /)).toBeNull();
  expect(screen.queryByText(/with the region/)).toBeNull();
});

test('org admins get Add location, and the line about the locations their request mentioned', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', LOCATIONS, 3) });
  const { router } = await renderApp('/dashboard', api);
  expect(await screen.findByText('Your request mentioned 3 locations. Add the others when you’re ready.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('link', { name: 'Add location' }));
  expect(router.getPathname()).toBe('/locations/new');
});

test('one location opens its Forecast tab', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', [LOCATIONS[0] ?? locationOf('l1', 'x', { townId: null, name: 'x', state: 'VT' })]) });
  const { router } = await renderApp('/dashboard', api);
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1'); });
  expect(await screen.findByText('Hanover, NH')).toBeTruthy();
});

test('empty, member: says the admin hasn’t added a location yet', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', []) });
  await renderApp('/dashboard', api);
  expect(await screen.findByText('Your admin hasn’t added a location yet.')).toBeTruthy();
  expect(screen.queryByLabelText('Name')).toBeNull();
});

test('empty, org admin: the Add location form inline adds the first location, named “{organization}, {Town}” with no Name field, and opens it', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', []) });
  const added = locationOf('l9', 'Test Group, Stowe', { townId: 'stowe-vt', name: 'Stowe', state: 'VT' });
  api.answers['/api/org/locations'] = () => {
    api.org = orgOf('org_admin', [added]);
    return { location: added };
  };
  const { router } = await renderApp('/dashboard', api);
  expect(await screen.findByRole('heading', { name: 'Add your first location' })).toBeTruthy();
  expect(screen.getByText('Pick its town. For the twelve towns Townwise profiles, you’ll see public data on what moves demand there.')).toBeTruthy();
  expect(screen.queryByLabelText('Name')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
  expect(screen.queryByText('Enter the location’s name.')).toBeNull();
  expect(screen.getByText('Pick a town, or choose Another town.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  await fireEvent.press(screen.getByLabelText('Town'));
  await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l9'); });
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/org/locations', body: { name: 'Test Group, Stowe', town: { townId: 'stowe-vt' } } }]);
});

test('Add location says when the name is taken, with the Name it sent, or the limit is reached', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', []) });
  api.answers['/api/org/locations'] = () => refusal(409, 'location_name_taken');
  await renderApp('/dashboard', api);
  await fireEvent.press(await screen.findByLabelText('Town'));
  await fireEvent.press(screen.getByRole('radio', { name: 'Another town' }));
  await fireEvent.changeText(screen.getByLabelText('Town name'), 'Norwich');
  await fireEvent.press(screen.getByLabelText('State'));
  await fireEvent.press(screen.getByRole('radio', { name: 'Vermont' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
  // Someone added a location of that name meanwhile: Name shows, with the name the form sent.
  expect(await screen.findByText('Another location already uses that name.')).toBeTruthy();
  expect(screen.getByLabelText('Name').props.value).toBe('Test Group, Norwich');
  expect(writes(api)[0]?.body).toEqual({ name: 'Test Group, Norwich', town: { townId: null, name: 'Norwich', state: 'VT' } });
  api.answers['/api/org/locations'] = () => refusal(409, 'location_limit');
  await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
  expect(await screen.findByText('You’ve reached 25 locations. Write to hello@townwise.tech for more.')).toBeTruthy();
});

test('an error shows the shared copy with Try again, which loads the list', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: offline() });
  await renderApp('/dashboard', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
  api.org = orgOf('member');
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('River Grill')).toBeTruthy();
});

test('view-as: Add location and the next steps that write are disabled, with the read-only line', async () => {
  const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin', [LOCATIONS[0] ?? locationOf('l1', 'x', { townId: null, name: 'x', state: 'VT' }), locationOf('l2', 'River Grill', { townId: null, name: 'Norwich', state: 'VT' }, {
    coverage: { dayCount: 3, guestsDayCount: 3, netSalesDayCount: 3, firstDate: '2026-01-01', lastDate: '2026-01-03', missingDays: 0 },
  })]) });
  const { router } = await renderApp('/dashboard', api);
  expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
  const add = screen.getByRole('button', { name: 'Add location' });
  expect(add.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(add);
  const note = screen.getByRole('button', { name: 'Add a note' });
  expect(note.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(note);
  expect(router.getPathname()).toBe('/dashboard');
});
