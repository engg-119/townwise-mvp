jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, screen } from 'expo-router/testing-library';

import { resetThemeMode, setThemeMode } from '../../src/portal/shell/themeMode';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';

// The apps stay dark and show no switch (src/portal/shell/ThemeToggle.tsx), whatever the store holds.

afterEach(async () => {
  await cleanup();
  resetThemeMode();
});

test.each(['dark', 'light'] as const)('the top bar has Sign out and no light or dark switch (store: %s)', async (mode) => {
  setThemeMode(mode);
  await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
  expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Switch to (light|dark) mode$/ })).toBeNull();
});
