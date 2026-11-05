jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { StyleSheet } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { townResearchLine } from '../../../src/portal/towns';
import { theme } from '../../../src/theme';
import {
  ACCESS, deferred, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { daysOf, locationsFake, salesOf, uploadOf, type LocationsFake } from './fakes';

// P11 Forecast and P15 Town on native (spec 16.3, 14, 13, D21).

afterEach(async () => {
  await cleanup();
});

const DAYS = daysOf('2025-01-01', 400, (index) => ({ guests: 50 + (index % 30), netSalesCents: index % 20 === 0 ? null : 150_000 }));

function setup(me = meOf(ACCESS.member), sales: Record<string, unknown> = {}): { api: FakePortalApi; fake: LocationsFake } {
  const fake = locationsFake({ sales });
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
}

describe('P11 Forecast', () => {
  test('loading names the location in place of the page', async () => {
    const pending = deferred<unknown>();
    const { api } = setup(meOf(ACCESS.member), { l1: pending.promise });
    await renderApp('/locations/l1', api);
    expect(await screen.findByText('Loading Main Street Bar')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Not calibrated yet' })).toBeNull();
  });

  test('with sales history: not calibrated, the data checks, the checklist, and the illustrative layout with slots only', async () => {
    const sales = salesOf(DAYS, [uploadOf('u2', { status: 'applying', uploadedAt: '2026-02-06T15:00:00.000Z' }), uploadOf('u1')]);
    const { api } = setup(meOf(ACCESS.member), { l1: sales });
    await renderApp('/locations/l1', api);
    expect(await screen.findByRole('heading', { name: 'Not calibrated yet' })).toBeTruthy();
    expect(screen.getByText('Your sales history is in: 400 days, Jan 1, 2025 to Feb 4, 2026. Calibration isn’t built yet, so there is no forecast.')).toBeTruthy();
    const checks: [string, string][] = [
      ['Days with data', '400'], ['First day', 'Jan 1, 2025'], ['Last day', 'Feb 4, 2026'], ['Missing days in between', '0'],
      ['Days with guests', '400'], ['Days with net sales', '380'], ['Last upload', 'Feb 5, 2026 by owner@example.com'],
    ];
    for (const [term, value] of checks) {
      expect(screen.getByText(term)).toBeTruthy();
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    // Days with data and days with guests.
    expect(screen.getAllByText('400')).toHaveLength(2);
    // Getting started, 01 to 04, with the client's own progress in plain words.
    for (const title of ['Your town', 'Upload your sales history', 'Calibration', 'Tell Townwise what it can’t see']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getByText('Public data on what moves demand in Hanover, NH.')).toBeTruthy();
    expect(screen.getByText(townResearchLine('hanover-nh'))).toBeTruthy();
    expect(screen.getByText('400 days, Jan 1, 2025 to Feb 4, 2026')).toBeTruthy();
    expect(screen.getByText('2 notes')).toBeTruthy();
    expect(screen.getAllByText('Not calibrated yet')).toHaveLength(2);
    // Upload is web only (D20): native says where to upload, and offers no button.
    expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Upload sales history' })).toBeNull();
    // What a forecast will show: slots, the qualifier, and build status tags; never a number.
    expect(screen.getByText('Illustrative layout, not real output')).toBeTruthy();
    for (const slot of ['{weekday}', '{date}', '{guests}', '{low}', '{high}', '{sales}', '{reason}']) expect(screen.getByText(slot)).toBeTruthy();
    expect(screen.getByText('In development. None of this is available to restaurants yet.')).toBeTruthy();
    expect(screen.getAllByText('In progress')).toHaveLength(2);
    expect(screen.getAllByText('Planned')).toHaveLength(2);
    expect(screen.queryAllByText(/\d guests/)).toHaveLength(0);
  });

  test('no sales history: the empty status, step 02 selected, and the town not researched yet', async () => {
    const { api } = setup(meOf(ACCESS.member), { l2: salesOf([]) });
    await renderApp('/locations/l2', api);
    expect(await screen.findByText('Upload your sales history to start. The upload sends Townwise only the date, guest count and net sales for each day.')).toBeTruthy();
    // The data checks show in every state (spec P11, 14.1), with nothing in them yet.
    for (const term of ['Days with data', 'First day', 'Last day', 'Missing days in between', 'Days with guests', 'Days with net sales', 'Last upload']) {
      expect(screen.getByText(term)).toBeTruthy();
    }
    expect(screen.getByText('No finished upload')).toBeTruthy();
    expect(screen.getAllByText('None')).toHaveLength(2);
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('Not started')).toBeTruthy();
    expect(screen.getByText('Not researched yet')).toBeTruthy();
    expect(screen.getByText('0 notes')).toBeTruthy();
    expect(screen.getAllByText('Upload from a computer at townwise.tech.')).toHaveLength(2);
    // The selected-row idiom: the step's title turns mint.
    const step = screen.getByRole('heading', { name: 'Upload your sales history' });
    expect(StyleSheet.flatten(step.props.style)).toMatchObject({ color: theme.color.mint });
    expect(StyleSheet.flatten(screen.getByRole('heading', { name: 'Your town' }).props.style)).toMatchObject({ color: theme.color.white });
  });

  test('its links open the Town and Notes tabs', async () => {
    const { api } = setup(meOf(ACCESS.member), { l1: salesOf(DAYS) });
    const { router } = await renderApp('/locations/l1', api);
    await fireEvent.press(await screen.findByRole('link', { name: 'See your town' }));
    expect(router.getPathname()).toBe('/locations/l1/town');
    await fireEvent.press(within(screen.getByLabelText('Location sections')).getByRole('link', { name: 'Forecast' }));
    await fireEvent.press(await screen.findByRole('link', { name: 'Add a note' }));
    expect(router.getPathname()).toBe('/locations/l1/notes');
  });

  test('an error shows the shared copy with Try again, which loads the page', async () => {
    const { api, fake } = setup(meOf(ACCESS.member), { l1: offline() });
    await renderApp('/locations/l1', api);
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    fake.sales.l1 = salesOf(DAYS);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Not calibrated yet' })).toBeTruthy();
  });

  test('a location the API doesn’t know is not available, with a way back to Locations', async () => {
    const { api } = setup(meOf(ACCESS.member), { l1: refusal(404, 'not_found') });
    const { router } = await renderApp('/locations/l1', api);
    expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
    const back = screen.getAllByRole('link', { name: 'Locations' }).at(-1);
    if (back === undefined) throw new Error('no way back');
    await fireEvent.press(back);
    expect(router.getPathname()).toBe('/dashboard');
  });

  test('view-as on native: the page reads the same, and nothing here writes, so there is no read-only line', async () => {
    const { api } = setup(viewAsMe(ACCESS.admin), { l2: salesOf([]) });
    await renderApp('/locations/l2', api);
    expect(await screen.findByText('Upload your sales history to start. The upload sends Townwise only the date, guest count and net sales for each day.')).toBeTruthy();
    expect(screen.queryByText('Read-only while viewing as gm@example.org.')).toBeNull();
  });
});

describe('P15 Town', () => {
  test('a researched town: the profile from the bundled data, with its text and numbers on native', async () => {
    const { api } = setup(meOf(ACCESS.member));
    await renderApp('/locations/l1/town', api);
    expect(await screen.findByRole('heading', { name: 'Hanover, NH' })).toBeTruthy();
    expect(screen.getByText('College town')).toBeTruthy();
    expect(screen.getByText('Measured across Grafton County, 2024.')).toBeTruthy();
    expect(screen.getByText('See the chart at townwise.tech.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Show the numbers/ }));
    expect(screen.getByLabelText('Numbers: Grafton County and the Northeast, 2024')).toBeTruthy();
  });

  test('another town gets the honest gap line and no chart; view-as changes nothing', async () => {
    const { api } = setup(viewAsMe(ACCESS.member));
    await renderApp('/locations/l2/town', api);
    expect(await screen.findByText('Townwise hasn’t researched Norwich, VT yet. Profiles cover twelve Northeast towns today.')).toBeTruthy();
    expect(screen.queryByText('See the chart at townwise.tech.')).toBeNull();
    expect(screen.queryByText('Read-only while viewing as gm@example.org.')).toBeNull();
  });
});
