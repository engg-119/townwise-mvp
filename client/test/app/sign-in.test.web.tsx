import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, Stack } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { loadGis } from '../../src/auth/gis.web';
import { resetGoogleButtonState } from '../../src/auth/GoogleButton';
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

// Renders /sign-in with Google's script stubbed; returns the container.
function mountSignIn(renderButton: jest.Mock<undefined, [HTMLElement, unknown]>): HTMLElement {
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
  return container;
}

// Renders /sign-in with Google's script stubbed and loaded; returns the card.
async function renderSignIn(): Promise<{ card: HTMLElement; renderButton: jest.Mock<undefined, [HTMLElement, unknown]> }> {
  const renderButton = jest.fn<undefined, [HTMLElement, unknown]>();
  const container = mountSignIn(renderButton);
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
  expect(screen.getByText('Use your Google account. Townwise has no passwords.')).toBeTruthy();
  expect(screen.getByText('New to Townwise? Continue with Google, then tell us about your restaurant. Joining your team? Use the email address your admin added.')).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms');
  expect(within(card).getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe('/privacy');
  for (const link of screen.getAllByRole('link', { name: 'Townwise' })) expect(link.getAttribute('href')).toBe('/');
  // /request-access would send a signed-out visitor straight back here, so the sign-in section has no early-access
  // link (the site header and footer keep theirs); the note under the card is spec P1's line.
  const page = document.querySelector<HTMLElement>('.pg-signin');
  if (page === null) throw new Error('no sign-in section');
  expect(within(page).queryByRole('link', { name: 'Request early access' })).toBeNull();
  expect(within(page).getByText('New to Townwise? Continue with Google, then tell us about your restaurant. Joining your team? Use the email address your admin added.')).toBeTruthy();
  expect(document.querySelector('input, textarea')).toBeNull();
  // The only button is the header's light/dark switch.
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.getAttribute('aria-label') ?? buttons[0]?.textContent).toMatch(/^Switch to (light|dark) mode$/);
  expect(screen.queryByText(/sign up/i)).toBeNull();
});

test('nothing on /sign-in offers early access, since /request-access leads back here; Sign in stays in the header', async () => {
  await renderSignIn();
  expect(screen.queryAllByRole('link', { name: 'Request early access' })).toEqual([]);
  expect(document.body.textContent).not.toContain('Request early access');
  const header = screen.getByRole('banner');
  expect(within(header).getAllByRole('link').map((link) => link.textContent).slice(-1)).toEqual(['Sign in']);
  const account = within(screen.getByRole('contentinfo')).getByRole('navigation', { name: 'Account' });
  expect(within(account).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Sign in', '/sign-in']]);
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

// The padding react-native-web's style sheet declares for an element's classes.
function paddingTop(element: Element): string[] {
  return [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
    .filter((rule): rule is CSSStyleRule => 'selectorText' in rule && [...element.classList].some((name) => rule.selectorText === `.${name}`))
    .map((rule) => rule.style.getPropertyValue('padding-top'))
    .filter((value) => value !== '');
}

test('on a phone the lines under the button are 16/24 and their links get 44px-tall tap targets; wider they stay 14/20', async () => {
  const window = Dimensions.get('window');
  for (const [width, phone] of [[390, true], [1024, false]] as const) {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...window, width });
    try {
      const { card } = await renderSignIn();
      const line = within(card).getByText('Use a Gmail address or a Google Workspace account.');
      expect([line.style.fontSize, line.style.lineHeight]).toEqual(phone ? ['16px', '24px'] : ['14px', '20px']);
      for (const name of ['Terms', 'Privacy Policy']) {
        expect(paddingTop(within(card).getByRole('link', { name })).includes('13px')).toBe(phone);
      }
      cleanup();
    } finally {
      spy.mockRestore();
    }
  }
});

test('a window resize resizes the lines under the button without drawing Google’s button again', async () => {
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 1024 });
  const { card, renderButton } = await renderSignIn();
  spy.mockRestore();
  const line = within(card).getByText('Use a Gmail address or a Google Workspace account.');
  expect(line.style.fontSize).toBe('14px');
  expect(renderButton).toHaveBeenCalledTimes(1);
  // jsdom has no layout, so the resize reports a width of 0: a phone. Google's button is drawn after a promise, so
  // let pending work run before counting.
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  expect(line.style.fontSize).toBe('16px');
  expect(renderButton).toHaveBeenCalledTimes(1);
});

test('through the shared loader (auth/gis.web.ts) sign-in is unchanged: one script tag when the Calendar’s loader ran first', async () => {
  const shared = loadGis();
  const renderButton = jest.fn<undefined, [HTMLElement, unknown]>();
  const container = mountSignIn(renderButton);
  expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  await shared;
  await waitFor(() => { expect(renderButton).toHaveBeenCalledTimes(1); });
  expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1);
  const card = container.querySelector<HTMLElement>('.pg-signin .card');
  for (const [parent, options] of renderButton.mock.calls) {
    expect(card?.contains(parent)).toBe(true);
    expect(options).toEqual({ text: 'continue_with' });
  }
});

test('a script that fails to load still says sign-in’s own words on /sign-in', async () => {
  mountSignIn(jest.fn<undefined, [HTMLElement, unknown]>());
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('error'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.');
  expect(document.querySelector(`script[src="${GIS}"]`)).toBeNull();
});
