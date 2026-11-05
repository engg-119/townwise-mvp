import { Text } from 'react-native';
import { cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import Dashboard from '../../app/(gate)/(app)/dashboard';
import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { fakeChatApi, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';

afterEach(async () => {
  await cleanup();
});

const EMAIL = ['a', 'example.com'].join('@');

function renderDashboard(api: FakeChatApi) {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  return renderRouter(
    {
      dashboard: Dashboard,
      'locations/[locationId]/chat': () => <Text>Chat screen</Text>,
      'settings/security': () => null,
    },
    { initialUrl: '/dashboard', wrapper: ({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider> },
  );
}

test('lists the organization’s locations, each linking to its tuning chat', async () => {
  const router = await renderDashboard(fakeChatApi());
  expect(await screen.findByText('Main Street Bar')).toBeTruthy();
  expect(screen.getByText('Test Group')).toBeTruthy();
  expect(screen.getByText('Hanover, NH')).toBeTruthy();
  expect(screen.getByText('River Grill')).toBeTruthy();
  expect(screen.getByText('Security')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  await fireEvent.press(screen.getByText('Main Street Bar'));
  expect(router.getPathname()).toBe('/locations/l1/chat');
});

test('a person with no organization sees a plain line, not an error', async () => {
  const api = fakeChatApi();
  api.org = refusal(403, 'no_access');
  await renderDashboard(api);
  const line = await screen.findByText('You’re not part of an organization yet.');
  expect(line.props.role).toBeUndefined();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Security')).toBeTruthy();
});

test('any other failure is an error', async () => {
  const api = fakeChatApi();
  api.org = new ApiError('network', 'The network request failed.');
  await renderDashboard(api);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText("Can't reach the server.")).toBeTruthy();
});
