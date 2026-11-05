import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot, Stack } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import TotpScreen from '../../app/(gate)/totp';
import { fakeAuth } from '../helpers/fakes';

// The site footer measures itself (as in sign-in.test.web.tsx).
class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => {
  cleanup();
});

// /totp on web: the Public frame (the site's header and footer, spec 15.1) around the second-step card.
function renderTotp(verifyMfa: () => Promise<void>): HTMLElement {
  const auth = fakeAuth({ status: 'mfaRequired', mfaToken: 'mfa-1' }, { verifyMfa });
  window.history.replaceState(null, '', '/totp');
  const { container } = render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({ _layout: () => <Stack />, totp: TotpScreen })}
        location="/totp"
        wrapper={({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider>}
      />
    </Head.Provider>,
  );
  const card = container.querySelector<HTMLElement>('.pg-signin .card');
  if (card === null) throw new Error('no sign-in card');
  return card;
}

test('the code field sits in the sign-in card, in the site header and footer, as a one-time numeric code', () => {
  const card = renderTotp(() => Promise.resolve());
  expect(within(screen.getByRole('banner')).getByRole('navigation', { name: 'Main' })).toBeTruthy();
  expect(screen.getByRole('contentinfo')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Townwise' })).toBeTruthy();
  expect(within(card).getByRole('heading', { level: 2, name: 'Enter your code' })).toBeTruthy();
  const input = within(card).getByLabelText('Code');
  expect(input.getAttribute('inputmode')).toBe('numeric');
  expect(input.getAttribute('autocomplete')).toBe('one-time-code');
  expect(within(card).getByRole('button', { name: 'Continue' })).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Use a recovery code instead' })).toBeTruthy();
});

test('a wrong code prints under the field, tied to it, as an assertive alert', async () => {
  const card = renderTotp(() => Promise.reject(new ApiError('http', 'invalid', { status: 400, code: 'invalid_code' })));
  const input = within(card).getByLabelText('Code');
  fireEvent.change(input, { target: { value: '123456' } });
  const message = await within(card).findByText('That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.');
  expect(message.getAttribute('role')).toBe('alert');
  expect(message.getAttribute('aria-live')).toBe('assertive');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const describedBy = input.getAttribute('aria-describedby') ?? '';
  expect(describedBy).not.toBe('');
  const list = document.getElementById(describedBy);
  expect(list?.contains(message)).toBe(true);
});
