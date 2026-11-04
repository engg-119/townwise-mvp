import { act, cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import TotpScreen from '../../app/totp';
import { fakeAuth } from '../helpers/fakes';

function wrap(auth: ReturnType<typeof fakeAuth>): React.ComponentType<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return <AuthProvider auth={auth}>{children}</AuthProvider>;
  };
}

test('two submits of the same code send one request', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const verifyMfa = jest.fn(() => held);
  const auth = fakeAuth({ status: 'mfaRequired', mfaToken: 'mfa-1' }, { verifyMfa });
  await renderRouter({ totp: TotpScreen }, { initialUrl: '/totp', wrapper: wrap(auth) });
  const field = screen.getByLabelText('Authentication code');
  await fireEvent.changeText(field, '123456');
  await fireEvent(field, 'submitEditing');
  expect(verifyMfa).toHaveBeenCalledTimes(1);
  expect(verifyMfa).toHaveBeenCalledWith({ code: '123456' });
  await act(async () => {
    release();
    await held;
  });
});

test('lockout copy states a wait only when the server sends Retry-After', async () => {
  const withWait = fakeAuth({ status: 'mfaRequired', mfaToken: 'mfa-1' }, {
    verifyMfa: () => Promise.reject(new ApiError('http', 'locked', { status: 429, retryAfterSeconds: 120 })),
  });
  await renderRouter({ totp: TotpScreen }, { initialUrl: '/totp', wrapper: wrap(withWait) });
  await fireEvent.changeText(screen.getByLabelText('Authentication code'), '123456');
  expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
  await cleanup();

  const without = fakeAuth({ status: 'mfaRequired', mfaToken: 'mfa-1' }, {
    verifyMfa: () => Promise.reject(new ApiError('http', 'locked', { status: 429 })),
  });
  await renderRouter({ totp: TotpScreen }, { initialUrl: '/totp', wrapper: wrap(without) });
  await fireEvent.changeText(screen.getByLabelText('Authentication code'), '123456');
  expect(await screen.findByText('Try again later.')).toBeTruthy();
});
