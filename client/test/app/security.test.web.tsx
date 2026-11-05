import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExpoRoot, Stack } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import type { Auth } from '../../src/auth/auth';
import { AuthProvider } from '../../src/auth/AuthProvider';
import SecurityScreen from '../../app/(gate)/(app)/(account)/settings/security';
import { fakeAuth } from '../helpers/fakes';

// Two-step setup on web, where a phone browser is the likely place it opens: the otpauth link (in a phone's browser
// only), Copy for the setup key, Copy all for the recovery codes, and the code error tied to its field.

// A made-up base32 setup key, low in entropy so it never reads as a real secret.
const SECRET = 'TOWNWISE'.repeat(4);
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

// The viewport width react-native-web reports (jsdom's is 0, a phone).
let width = 375;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
  setWidth(375);
});

/** The copy result's polite live region beside the button. */
function copyStatus(): HTMLElement {
  const region = screen.getAllByRole('status').find((element) => element.getAttribute('aria-live') === 'polite' && element.querySelector('[role="status"]') === null);
  if (region === undefined) throw new Error('no copy status');
  return region;
}

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

test('in a phone’s browser the authenticator link is a real otpauth link, and Copy copies the key without its spaces', async () => {
  await startSetup();
  expect(screen.getByRole('link', { name: 'Open in authenticator app' }).getAttribute('href')).toBe(URI);
  expect(screen.getByText('TOWN WISE TOWN WISE TOWN WISE TOWN WISE')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(SECRET);
});

test('a desktop browser has no authenticator link to open: the QR, the setup key and Copy', async () => {
  setWidth(1280);
  await startSetup();
  expect(screen.getByLabelText('Authentication QR code')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open in authenticator app' })).toBeNull();
});

test('Copied is said politely, from a live region that was there before the press', async () => {
  await startSetup();
  const region = copyStatus();
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(region.textContent).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByRole('button', { name: 'Copied' });
  expect(copyStatus()).toBe(region);
  expect(region.textContent).toBe('Copied');
});

test('a copy the browser refuses says how to copy by hand, politely, and the line describes the button', async () => {
  writeText.mockRejectedValue(new Error('denied'));
  await startSetup();
  const region = copyStatus();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  const line = await screen.findByText('Couldn’t copy. Select the text and copy it.');
  expect(region.contains(line)).toBe(true);
  expect(region.getAttribute('aria-live')).toBe('polite');
  const button = screen.getByRole('button', { name: 'Copy' });
  expect(line.id).not.toBe('');
  expect(button.getAttribute('aria-describedby')).toBe(line.id);
});

test('a wrong code is tied to the code field, as an assertive alert', async () => {
  await startSetup({ confirmTotpEnrollment: () => Promise.reject(new ApiError('http', 'invalid', { status: 400, code: 'invalid_code' })) });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  const message = await screen.findByText('That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.');
  expect(message.getAttribute('role')).toBe('alert');
  expect(message.getAttribute('aria-live')).toBe('assertive');
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
