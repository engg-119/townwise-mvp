jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});

import { cleanup, fireEvent, render } from '@testing-library/react-native';

afterEach(async () => {
  await cleanup();
});

import { ApiError, createApiClient } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { createAuth, type Auth } from '../../src/auth/auth';
import { createAuthStore } from '../../src/auth/store';
import SignIn from '../../app/sign-in';
import { fakeAuth, fakeFetch, jsonResponse, requestText } from '../helpers/fakes';

const EMAIL = ['a', 'example.com'].join('@');
const CONFIRMATION = 'If that address can sign in, a link is on its way.';

function provider(auth: Auth): React.ComponentType<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return <AuthProvider auth={auth}>{children}</AuthProvider>;
  };
}

async function submitEmail(view: Awaited<ReturnType<typeof render>>, email: string): Promise<void> {
  await fireEvent.changeText(view.getByLabelText('Email'), email);
  await fireEvent.press(view.getByText('Email me a link'));
  expect(view.getByText(CONFIRMATION)).toBeTruthy();
}

test('shows the same confirmation whatever the server says about the account', async () => {
  const ok = fakeAuth({ status: 'signedOut' }, { requestMagicLink: () => Promise.resolve() });
  const first = await render(<SignIn />, { wrapper: provider(ok) });
  await submitEmail(first, EMAIL);
  await cleanup();

  const missing = fakeAuth({ status: 'signedOut' }, {
    requestMagicLink: () => Promise.reject(new ApiError('http', 'missing', { status: 404, code: 'not_found' })),
  });
  const second = await render(<SignIn />, { wrapper: provider(missing) });
  await submitEmail(second, EMAIL);
});

test('accepts an email with surrounding spaces', async () => {
  const network = fakeFetch(() => jsonResponse(202, { ok: true }));
  const store = createAuthStore({ status: 'signedOut' });
  const session = { kind: 'cookie' as const };
  const auth = createAuth({
    api: createApiClient({
      baseUrl: 'https://api.example.com',
      session,
      fetch: network.fetch,
      onSessionEnded: () => undefined,
    }),
    session,
    store,
    config: { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google: null },
  });
  const view = await render(<SignIn />, { wrapper: provider(auth) });
  await submitEmail(view, `  ${EMAIL}  `);
  expect(view.getByText(CONFIRMATION)).toBeTruthy();
  const posts = network.calls.filter((call) => new URL(call.url).pathname === '/auth/magic-link');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(requestText(posts[0]?.init.body))).toEqual({ email: EMAIL, platform: 'web' });
  expect(view.queryByText('Enter an email address.')).toBeNull();
});

test('hides the email form when webUrl is unset', async () => {
  const auth = fakeAuth({ status: 'signedOut' }, {
    config: { apiUrl: 'https://api.example.com', webUrl: null, google: null },
  });
  const view = await render(<SignIn />, { wrapper: provider(auth) });
  expect(view.queryByLabelText('Email')).toBeNull();
});
