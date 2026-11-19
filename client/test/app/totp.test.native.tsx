import { AccessibilityInfo } from 'react-native';
import { act, cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import TotpScreen from '../../app/(gate)/totp';
import { fakeAuth } from '../helpers/fakes';

function wrap(auth: ReturnType<typeof fakeAuth>): React.ComponentType<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return <AuthProvider auth={auth}>{children}</AuthProvider>;
  };
}

async function renderTotp(overrides?: Parameters<typeof fakeAuth>[1]): Promise<ReturnType<typeof fakeAuth>> {
  const auth = fakeAuth({ status: 'mfaRequired', mfaToken: 'mfa-1' }, overrides);
  await renderRouter({ totp: TotpScreen }, { initialUrl: '/totp', wrapper: wrap(auth) });
  return auth;
}

const INVALID = () => Promise.reject(new ApiError('http', 'invalid', { status: 400, code: 'invalid_code' }));

test('the sign-in frame with the board’s second step: heading, guidance, Code, Continue, and the recovery view', async () => {
  await renderTotp();
  expect(screen.getByRole('heading', { name: 'Sign in to Townwise' })).toBeTruthy();
  expect(screen.getByText('Your account uses two-step sign-in.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Request early access' })).toBeNull();
  expect(screen.queryByText(/Forecasts are live for early-access restaurants/)).toBeNull();
  expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
  expect(screen.getByText('Open your authenticator app and enter the 6-digit code for Townwise.')).toBeTruthy();
  const field = screen.getByLabelText('Code');
  expect(field.props).toMatchObject({ inputMode: 'numeric', autoComplete: 'one-time-code', textContentType: 'oneTimeCode', keyboardType: 'number-pad' });
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Use a recovery code instead' }));
  expect(screen.getByRole('heading', { name: 'Enter a recovery code' })).toBeTruthy();
  expect(screen.getByLabelText('Recovery code')).toBeTruthy();
  expect(screen.getByText('Each recovery code works once.')).toBeTruthy();
  expect(screen.queryByLabelText('Code')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Use your authenticator app instead' }));
  expect(screen.getByLabelText('Code')).toBeTruthy();
});

test('six digits send themselves; two submits of the same code send one request', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const verifyMfa = jest.fn(() => held);
  await renderTotp({ verifyMfa });
  const field = screen.getByLabelText('Code');
  await fireEvent.changeText(field, '123 456');
  await fireEvent(field, 'submitEditing');
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(verifyMfa).toHaveBeenCalledTimes(1);
  expect(verifyMfa).toHaveBeenCalledWith({ code: '123456' });
  await act(async () => {
    release();
    await held;
  });
});

test('Continue with fewer than six digits says so under the field and sends nothing', async () => {
  const verifyMfa = jest.fn(() => Promise.resolve());
  await renderTotp({ verifyMfa });
  await fireEvent.changeText(screen.getByLabelText('Code'), '1234');
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeTruthy();
  expect(verifyMfa).not.toHaveBeenCalled();
});

test('a wrong code prints the board’s message, with a curly apostrophe', async () => {
  await renderTotp({ verifyMfa: INVALID });
  await fireEvent.changeText(screen.getByLabelText('Code'), '123456');
  expect(await screen.findByText('That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.')).toBeTruthy();
});

test.each([
  ['code', 'That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.'],
  ['recovery code', 'That recovery code didn’t work. Each one works once.'],
] as const)('a wrong %s under the field is an alert: the role, an assertive live region, and an announcement on iOS', async (kind, text) => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  await renderTotp({ verifyMfa: INVALID });
  if (kind === 'code') {
    await fireEvent.changeText(screen.getByLabelText('Code'), '123456');
  } else {
    await fireEvent.press(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await fireEvent.changeText(screen.getByLabelText('Recovery code'), 'abcde-01234-abcde-56789');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  }
  const message = await screen.findByText(text);
  expect(message.props.role).toBe('alert');
  expect(message.props['aria-live']).toBe('assertive');
  expect(announce).toHaveBeenCalledWith(text);
  announce.mockRestore();
});

test('a recovery code goes normalized; a wrong one says so without the 30-second hint', async () => {
  const verifyMfa = jest.fn(INVALID);
  await renderTotp({ verifyMfa });
  await fireEvent.press(screen.getByRole('button', { name: 'Use a recovery code instead' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Enter one of your recovery codes.')).toBeTruthy();
  expect(verifyMfa).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Recovery code'), 'ABCDE-01234-abcde-56789');
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(verifyMfa).toHaveBeenCalledWith({ recoveryCode: 'abcde01234abcde56789' });
  expect(await screen.findByText('That recovery code didn’t work. Each one works once.')).toBeTruthy();
  expect(screen.queryByText(/30 seconds/)).toBeNull();
});

test('Use a different account cancels the second step', async () => {
  const auth = await renderTotp();
  await fireEvent.press(screen.getByRole('button', { name: 'Use a different account' }));
  expect(auth.store.getState()).toEqual({ status: 'signedOut' });
});

test('lockout copy states a wait only when the server sends Retry-After', async () => {
  await renderTotp({ verifyMfa: () => Promise.reject(new ApiError('http', 'locked', { status: 429, retryAfterSeconds: 120 })) });
  await fireEvent.changeText(screen.getByLabelText('Code'), '123456');
  expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
  await cleanup();

  await renderTotp({ verifyMfa: () => Promise.reject(new ApiError('http', 'locked', { status: 429 })) });
  await fireEvent.changeText(screen.getByLabelText('Code'), '123456');
  expect(await screen.findByText('Too many attempts. Try again later.')).toBeTruthy();
});
