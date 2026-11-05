import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, Stack } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { resetGoogleButtonState } from '../../src/auth/GoogleButton';
import { EARLY_ACCESS_HREF } from '../../src/marketing/links';
import SignIn from '../../app/(gate)/sign-in';
import { fakeAuth } from '../helpers/fakes';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

const GIS = 'https://accounts.google.com/gsi/client';
const google = { webClientId: '123-abc.apps.googleusercontent.com', iosClientId: null };

beforeEach(() => {
  resetGoogleButtonState();
  delete (window as { google?: unknown }).google;
});

afterEach(() => {
  cleanup();
});

// Renders /sign-in with Google's script stubbed and loaded; returns the card.
async function renderSignIn(): Promise<{ card: HTMLElement; renderButton: jest.Mock<undefined, [HTMLElement, unknown]> }> {
  const renderButton = jest.fn<undefined, [HTMLElement, unknown]>();
  (window as { google?: unknown }).google = { accounts: { id: { initialize: jest.fn(), renderButton } } };
  const auth = fakeAuth({ status: 'signedOut' }, {
    config: { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google },
  });
  window.history.replaceState(null, '', '/sign-in');
  // The web entry wraps the app in Head's provider (expo-router's qualified-entry).
  const { container } = render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({ _layout: () => <Stack />, 'sign-in': SignIn })}
        location="/sign-in"
        wrapper={({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider>}
      />
    </Head.Provider>,
  );
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  await waitFor(() => { expect(renderButton).toHaveBeenCalled(); });
  const card = container.querySelector<HTMLElement>('.pg-signin .card');
  if (card === null) throw new Error('no sign-in card');
  return { card, renderButton };
}

test('one Continue with Google button, links to the terms and privacy pages, and no email field', async () => {
  const { card, renderButton } = await renderSignIn();

  // Google draws the button into one container in the card, with the "Continue with Google" text.
  expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1);
  const parents = new Set(renderButton.mock.calls.map(([parent]) => parent));
  expect(parents.size).toBe(1);
  for (const parent of parents) expect(card.contains(parent)).toBe(true);
  for (const [, options] of renderButton.mock.calls) expect(options).toEqual({ text: 'continue_with' });

  expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Townwise' })).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms');
  expect(within(card).getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe('/privacy');
  for (const link of screen.getAllByRole('link', { name: 'Townwise' })) expect(link.getAttribute('href')).toBe('/');
  for (const link of screen.getAllByRole('link', { name: 'Request early access' })) expect(link.getAttribute('href')).toBe(EARLY_ACCESS_HREF);
  expect(document.querySelector('input, textarea')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText(/sign up/i)).toBeNull();
});

test('sign-in sits in the site header and footer, with the legal links and its own title', async () => {
  await renderSignIn();
  const header = screen.getByRole('banner');
  expect(within(header).getByRole('navigation', { name: 'Main' })).toBeTruthy();
  expect(within(header).getByRole('link', { name: 'Sign in' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('main').id).toBe('main');
  expect(screen.getByRole('region', { name: 'Sign in to Townwise' })).toBeTruthy();

  const legal = within(screen.getByRole('list', { name: 'Legal' })).getAllByRole('link');
  expect(legal.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Privacy', '/privacy'], ['Terms', '/terms'], ['Security', '/security'],
  ]);
  const footer = screen.getByRole('contentinfo');
  for (const group of ['Product', 'Company', 'Legal', 'Account']) {
    expect(within(footer).getByRole('navigation', { name: group })).toBeTruthy();
  }
  await waitFor(() => { expect(document.title).toBe('Townwise Sign in'); });
});
