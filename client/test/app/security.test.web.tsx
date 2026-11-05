import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExpoRoot, Stack } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import type { Auth } from '../../src/auth/auth';
import { AuthProvider } from '../../src/auth/AuthProvider';
import SecurityScreen from '../../app/(gate)/(app)/(account)/settings/security';
import { fakeAuth } from '../helpers/fakes';

// Two-step setup on web, where a phone browser is the likely place it opens: the otpauth link, Copy for the setup
// key, Copy all for the recovery codes, and the code error tied to its field.

const SECRET = 'KMHFNWBKLCASYTCLSGMC4WF2E2PH7FYQ';
const URI = `otpauth://totp/Townwise:a?secret=${SECRET}&issuer=Townwise`;
const CODES = ['aaaaa-bbbbb-ccccc-ddddd', 'eeeee-fffff-00000-11111'];
const writeText = jest.fn<Promise<void>, [string]>();

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

async function startSetup(overrides?: Partial<Auth>): Promise<void> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: 'a@example.com' } }, {
    beginTotpEnrollment: () => Promise.resolve({ secret: SECRET, otpauthUri: URI, expiresAt: '2026-01-01T00:00:00Z', qrPngDataUrl: 'data:image/png;base64,AAAA' }),
    confirmTotpEnrollment: () => Promise.resolve({ recoveryCodes: CODES }),
    ...overrides,
  });
  window.history.replaceState(null, '', '/security');
  render(
    <ExpoRoot
      context={getMockContext({ _layout: () => <Stack />, security: SecurityScreen })}
      location="/security"
      wrapper={({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider>}
    />,
  );
  const start = await screen.findByRole('button', { name: 'Set up two-step sign-in' });
  fireEvent.click(start);
  await screen.findByText('Setup key');
}

test('the authenticator link is a real otpauth link on web too, and Copy copies the key without its spaces', async () => {
  await startSetup();
  expect(screen.getByRole('link', { name: 'Open in authenticator app' }).getAttribute('href')).toBe(URI);
  expect(screen.getByText('KMHF NWBK LCAS YTCL SGMC 4WF2 E2PH 7FYQ')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(SECRET);
});

test('a copy the browser refuses says how to copy by hand', async () => {
  writeText.mockRejectedValue(new Error('denied'));
  await startSetup();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(await screen.findByText('Couldn’t copy. Select the text and copy it.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});

test('a wrong code is tied to the code field', async () => {
  await startSetup({ confirmTotpEnrollment: () => Promise.reject(new ApiError('http', 'invalid', { status: 400, code: 'invalid_code' })) });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  const message = await screen.findByText('That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.');
  const input = screen.getByLabelText('Code');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.contains(message)).toBe(true);
});

test('the recovery codes sit in a named list, and Copy all copies them one per line', async () => {
  await startSetup();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Recovery codes' }).textContent).toBe(CODES.join(''));
  fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
});
