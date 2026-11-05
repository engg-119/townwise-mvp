import { render, screen, waitFor } from '@testing-library/react';

import { GoogleButton, resetGoogleButtonState } from '../../src/auth/GoogleButton';

const GIS = 'https://accounts.google.com/gsi/client';
const google = { webClientId: '123-abc.apps.googleusercontent.com', iosClientId: null };

beforeEach(() => {
  resetGoogleButtonState();
  delete (window as { google?: unknown }).google;
});

test('script injected once across remounts', async () => {
  const props = { google, onIdToken: jest.fn(), onError: jest.fn() };
  const first = render(<GoogleButton {...props} />);
  await waitFor(() => { expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1); });
  first.unmount();
  render(<GoogleButton {...props} />);
  expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1);
});

test('initialize called once', async () => {
  const initialize = jest.fn();
  const renderButton = jest.fn();
  (window as { google?: unknown }).google = { accounts: { id: { initialize, renderButton } } };
  const props = { google, onIdToken: jest.fn(), onError: jest.fn() };
  const first = render(<GoogleButton {...props} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  await waitFor(() => { expect(initialize).toHaveBeenCalledTimes(1); });
  first.unmount();
  render(<GoogleButton {...props} />);
  await waitFor(() => { expect(renderButton.mock.calls.length).toBeGreaterThan(0); });
  expect(initialize).toHaveBeenCalledTimes(1);
});

test('the credential reaches the mounted handler', async () => {
  let callback: ((response: { credential?: string }) => void) | undefined;
  const initialize = jest.fn((config: { callback: (response: { credential?: string }) => void }) => { callback = config.callback; });
  (window as { google?: unknown }).google = { accounts: { id: { initialize, renderButton: jest.fn() } } };
  const onIdToken = jest.fn();
  render(<GoogleButton google={google} onIdToken={onIdToken} onError={jest.fn()} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  await waitFor(() => { expect(initialize).toHaveBeenCalled(); });
  callback?.({ credential: 'gis-token' });
  expect(onIdToken).toHaveBeenCalledWith('gis-token');
});

test('load failure shows the unavailable message, as an alert screen readers announce', async () => {
  render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('error'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.');
  expect(alert.getAttribute('aria-live')).toBe('assertive');
});

test('after a load failure, the next mount injects a fresh tag', async () => {
  const first = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  const failed = document.querySelector(`script[src="${GIS}"]`);
  failed?.dispatchEvent(new Event('error'));
  await screen.findByText('Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.');
  expect(document.querySelector(`script[src="${GIS}"]`)).toBeNull();
  first.unmount();
  render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  await waitFor(() => { expect(document.querySelector(`script[src="${GIS}"]`)).not.toBeNull(); });
});
