import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, router } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetThemeMode, setThemeMode } from '../../src/portal/shell/themeMode';
import { theme } from '../../src/theme';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, staffMe, type FakePortalApi } from '../helpers/portal';

// The light and dark switch on web (src/portal/shell/ThemeToggle.web.tsx, SiteTheme in PortalStyles.web.tsx): in
// every top bar, just before Sign out, at desktop and phone widths. The site's one mode (the system's setting until the
// person picks one) is data-theme on <html> and the browser's theme-color on every page: a public page opened from the
// portal keeps it, and a pick made in the public header (test/marketing/theme.test.web.tsx) holds in the portal.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

const DARK = theme.palette.dark.ground;
const meta = document.createElement('meta');
meta.name = 'theme-color';
meta.content = DARK;
document.head.appendChild(meta);

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  localStorage.clear();
  resetThemeMode();
  Reflect.deleteProperty(window, 'matchMedia');
  setWidth(1280);
  // Nothing takes the mode off the page (a new page load starts without it), so each test starts clean.
  delete document.documentElement.dataset.theme;
  meta.content = DARK;
});

function renderAt(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

const BARS = [
  ['gate', '/waiting', 'Your request is in', () => fakePortalApi({ me: meOf(ACCESS.pending) })],
  ['client app', '/locations/l1/notes', 'Notes', () => fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') })],
  ['staff console', '/admin', 'Requests', () => fakePortalApi({ me: staffMe() })],
] as const;

/** The page's bar once GET /api/me has answered (until then the gate frame says “Checking your access”). */
async function barOf(title: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1, name: title });
  return screen.getByRole('banner');
}

function parentOf(element: HTMLElement): HTMLElement {
  if (element.parentElement === null) throw new Error('no parent');
  return element.parentElement;
}

function lightOn(): boolean {
  return document.documentElement.dataset.theme === 'light';
}

function shown(): string | undefined {
  return document.documentElement.dataset.theme;
}

describe.each([1280, 320])('at %ipx', (at) => {
  test.each(BARS)('the %s bar has the switch just before Sign out, together at their own widths', async (_bar, path, title, api) => {
    setWidth(at);
    renderAt(path, api());
    const bar = await barOf(title);
    const signOut = within(bar).getByRole('button', { name: 'Sign out' });
    const toggle = within(bar).getByRole('button', { name: 'Switch to light mode' });
    expect(toggle.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(parentOf(toggle)).toBe(parentOf(signOut));
    // Neither shrinks, so Sign out can't pass the margin or wrap to “Sign / out”; the switch is a 44px square.
    const group = window.getComputedStyle(parentOf(toggle));
    expect(group.flexShrink).toBe('0');
    expect(window.getComputedStyle(toggle).width).toBe('44px');
    expect(window.getComputedStyle(toggle).height).toBe('44px');
    expect(window.getComputedStyle(toggle).flexShrink).toBe('0');
    // The icon is decorative; the button's name says what it does.
    expect(toggle.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

test('at 320px the console bar is two rows in one band: the switch beside the wordmark, Sign out beside the verified time', async () => {
  setWidth(320);
  renderAt('/admin', fakePortalApi({ me: staffMe() }));
  const bar = await barOf('Requests');
  const signOut = within(bar).getByRole('button', { name: 'Sign out' });
  const group = parentOf(signOut);
  expect(window.getComputedStyle(group).flexDirection).toBe('column');
  expect(window.getComputedStyle(group).alignItems).toBe('flex-end');
  const verified = within(bar).getByText(/^Verified until /);
  expect(window.getComputedStyle(parentOf(verified)).minHeight).toBe('44px');
});

test('the switch puts the light palette on the page and back, and the browser remembers it', async () => {
  renderAt('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
  const bar = await barOf('Notes');
  expect(shown()).toBe('dark');
  fireEvent.click(within(bar).getByRole('button', { name: 'Switch to light mode' }));
  expect(shown()).toBe('light');
  expect(meta.content).toBe(theme.palette.light.ground);
  expect(localStorage.getItem('townwise.theme')).toBe('light');
  // The same control, now named for the way back.
  fireEvent.click(within(bar).getByRole('button', { name: 'Switch to dark mode' }));
  expect(shown()).toBe('dark');
  expect(meta.content).toBe(DARK);
  expect(localStorage.getItem('townwise.theme')).toBe('dark');
});

test('with nothing picked the portal follows the system: light when it asks for light, and a press overrides it', async () => {
  // jsdom has no matchMedia: a system set to light (and no reduced motion), for the portal's other readers too.
  const light = (query: string): Pick<MediaQueryList, 'media' | 'matches' | 'addEventListener' | 'removeEventListener'> => ({
    media: query,
    matches: query === '(prefers-color-scheme: light)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: light });
  renderAt('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
  const bar = await barOf('Notes');
  expect(shown()).toBe('light');
  expect(meta.content).toBe(theme.palette.light.ground);
  expect(localStorage.getItem('townwise.theme')).toBeNull();
  // The press flips the mode shown and is remembered, so the system no longer decides.
  fireEvent.click(within(bar).getByRole('button', { name: 'Switch to dark mode' }));
  expect(shown()).toBe('dark');
  expect(localStorage.getItem('townwise.theme')).toBe('dark');
});

test('storage that throws: the portal opens dark, and a press still switches for the page', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  renderAt('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
  const bar = await barOf('Notes');
  expect(shown()).toBe('dark');
  fireEvent.click(within(bar).getByRole('button', { name: 'Switch to light mode' }));
  expect(shown()).toBe('light');
});

test('a light pick made earlier is on the page as the portal opens', async () => {
  act(() => { setThemeMode('light'); });
  expect(lightOn()).toBe(false);
  renderAt('/waiting', fakePortalApi({ me: meOf(ACCESS.pending) }));
  // From the first frame, “Checking your access” included.
  expect(lightOn()).toBe(true);
  expect(within(await barOf('Your request is in')).getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
});

test('a public page opened from the portal keeps the mode, and so does coming back', async () => {
  act(() => { setThemeMode('light'); });
  renderAt('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
  const footer = await screen.findByRole('contentinfo');
  expect(lightOn()).toBe(true);
  fireEvent.click(within(footer).getByRole('link', { name: 'Privacy' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/privacy'); });
  // The root stack keeps the portal mounted, out of view, under the public page; the mode is the site's, so neither
  // the portal going out of view nor the public page decides it.
  expect(document.getElementById('tw-portal')).not.toBeNull();
  expect(lightOn()).toBe(true);
  expect(meta.content).toBe(theme.palette.light.ground);
  const header = document.querySelector<HTMLElement>('.tw .nav');
  if (header === null) throw new Error('no public header');
  expect(within(header).getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
  act(() => { router.back(); });
  await waitFor(() => { expect(window.location.pathname).toBe('/dashboard'); });
  expect(lightOn()).toBe(true);
});

test('a pick made in the public header holds in the portal', async () => {
  renderAt('/privacy', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
  const header = document.querySelector<HTMLElement>('.tw .nav');
  if (header === null) throw new Error('no public header');
  expect(shown()).toBe('dark');
  fireEvent.click(within(header).getByRole('button', { name: 'Switch to light mode' }));
  expect(shown()).toBe('light');
  expect(localStorage.getItem('townwise.theme')).toBe('light');
  act(() => { router.push('/dashboard'); });
  await waitFor(() => { expect(window.location.pathname).toBe('/dashboard'); });
  const portal = await waitFor(() => {
    const root = document.getElementById('tw-portal');
    if (root === null) throw new Error('no portal yet');
    return root;
  });
  // The public page stays mounted under the portal, so the portal's own bar is looked up inside it.
  expect(await within(within(portal).getByRole('banner')).findByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
  expect(lightOn()).toBe(true);
  expect(meta.content).toBe(theme.palette.light.ground);
});
