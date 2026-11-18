jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Dimensions, StyleSheet } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import { fakeChatApi } from '../helpers/chat';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { serveAbout } from './about-fakes';

// Suggested closure rules in P25's sheet on native (D46): the section first, each card's words, 44px Confirm, Edit and
// Dismiss, Edit a link to P29's form, and Confirm sending to the suggested rules' route.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as { panel: { questions: unknown[]; activity: unknown[] } };

afterEach(async () => {
  await cleanup();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
  jest.restoreAllMocks();
});

function minHeightOf(element: { props: { style?: unknown } }): number {
  return (StyleSheet.flatten(element.props.style as object) as { minHeight?: number }).minHeight ?? 0;
}

test('the sheet shows Suggested rules first, with 44px Confirm, Edit and Dismiss, and Confirm says what it did', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 375 });
  const chat = fakeChatApi();
  chat.panel = fixture.panel;
  chat.respond['/api/org/locations/l1/agent/rule-suggestions/sales_weekday_1/accept'] = () => ({ suggestion: { id: 'n1', status: 'accepted' }, rule: null });
  serveAbout(chat);
  await renderApp('/locations/l1/agent?panel=questions', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: chat }));
  const side = await screen.findByTestId('agent-side');
  expect(within(side).getAllByRole('heading')[0]?.props.children).toBe('Suggested rules');
  // Its count, and the weekly section's below it.
  expect(within(side).getAllByText('2 to decide')).toHaveLength(2);
  expect(within(side).getByText('Changes the forecast: Closed on Mondays from Mar 1, 2026')).toBeTruthy();
  expect(within(side).getByText('In your sales history, 13 of 13 Mondays had no sales.')).toBeTruthy();
  expect(within(side).getByRole('link', { name: 'From Sentinel-file-name.csv' })).toBeTruthy();
  for (const name of ['Confirm “Closed on Mondays”', 'Dismiss “Closed on Mondays”']) {
    expect(minHeightOf(within(side).getByRole('button', { name }))).toBeGreaterThanOrEqual(44);
  }
  expect(minHeightOf(within(side).getByRole('link', { name: 'Edit “Closed on Mondays”' }))).toBeGreaterThanOrEqual(44);
  await fireEvent.press(within(side).getByRole('button', { name: 'Confirm “Closed on Mondays”' }));
  expect(await within(side).findByText('Added the business rule “Closed on Mondays”.')).toBeTruthy();
  expect(within(side).getAllByText(/^\d to decide$/).map((line) => line.props.children as unknown)).toEqual(['1 to decide', '2 to decide']);
  expect(chat.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/agent/rule-suggestions/sales_weekday_1/accept', body: {} }]);
});
