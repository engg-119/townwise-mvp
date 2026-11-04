import { StrictMode } from 'react';
import { act, cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import MagicLinkScreen from '../../app/auth/magic';
import { fakeAuth } from '../helpers/fakes';
import type { Auth } from '../../src/auth/auth';

const EMAIL = ['a', 'example.com'].join('@');
const token = 'A'.repeat(43);
const initialUrl = `/auth/magic#token=${token}&email=a%40example.com`;

function wrap(auth: Auth): React.ComponentType<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return (
      <StrictMode>
        <AuthProvider auth={auth}>{children}</AuthProvider>
      </StrictMode>
    );
  };
}

test('does not redeem on mount; shows the destination email; redeems once on press', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const redeemMagicLink = jest.fn(() => held);
  const auth = fakeAuth({ status: 'signedOut' }, { redeemMagicLink });
  await renderRouter(
    { 'auth/magic': MagicLinkScreen, totp: () => null, index: () => null },
    { initialUrl, wrapper: wrap(auth) },
  );
  expect(redeemMagicLink).not.toHaveBeenCalled();
  expect(screen.getByText(`Sign in as ${EMAIL}?`)).toBeTruthy();
  await fireEvent.press(screen.getByText('Continue'));
  await fireEvent.press(screen.getByText('Continue'));
  expect(redeemMagicLink).toHaveBeenCalledTimes(1);
  expect(redeemMagicLink).toHaveBeenCalledWith({ token, email: EMAIL });
  await act(async () => {
    release();
    await held;
  });
});

test('a link shows the destination email before any session is created', async () => {
  const auth = fakeAuth({ status: 'signedOut' });
  const view = await renderRouter({ 'auth/magic': MagicLinkScreen }, { initialUrl, wrapper: wrap(auth) });
  expect(view.getByText(`Sign in as ${EMAIL}?`)).toBeTruthy();
  expect(auth.store.getState().status).toBe('signedOut');
});

test('a redeem that returns mfa_required lands on /totp', async () => {
  const auth = fakeAuth({ status: 'signedOut' });
  auth.redeemMagicLink = () => {
    auth.store.set({ status: 'mfaRequired', mfaToken: 'mfa-1' });
    return Promise.resolve();
  };
  const router = await renderRouter(
    { 'auth/magic': MagicLinkScreen, totp: () => null, index: () => null },
    { initialUrl, wrapper: wrap(auth) },
  );
  await fireEvent.press(router.getByText('Continue'));
  await screen.findByText('Continue').catch(() => undefined);
  expect(router.getPathname()).toBe('/totp');
});

test('the expired-link message does not show the email', async () => {
  const auth = fakeAuth({ status: 'signedOut' }, {
    redeemMagicLink: () => Promise.reject(new ApiError('http', 'expired', { status: 400, code: 'invalid_or_expired_link' })),
  });
  const view = await renderRouter({ 'auth/magic': MagicLinkScreen }, { initialUrl, wrapper: wrap(auth) });
  await fireEvent.press(view.getByText('Continue'));
  expect(await screen.findByText('Links work once, for 15 minutes, on the device where you asked for them. Request a new one.')).toBeTruthy();
  expect(screen.queryByText(EMAIL, { exact: false })).toBeNull();
  await cleanup();
});
