import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { AuthState } from '../../src/auth/store';
import { homeCss } from '../../src/marketing/homeStyles.web';
import { mapCss } from '../../src/marketing/map/mapStyles.web';
import { storyCss } from '../../src/marketing/map/storyStyles.web';
import { css } from '../../src/marketing/styles.web';
import { resetThemeMode, THEME_STORAGE_KEY } from '../../src/portal/shell/themeMode';
import { colorVar, theme } from '../../src/theme';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';

// The public pages (the homepage, About, Privacy, Terms, Security, sign-in and the two-step page) show the site's one
// light or dark mode, as the portal does (src/portal/shell/themeMode.ts, SiteTheme in PortalStyles.web.tsx): the
// system's setting until the person picks with the switch in the header (ThemeToggle, the portal's), then the pick,
// kept in localStorage "townwise.theme". The portal's side is test/portal/theme-toggle.test.web.tsx.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

const DARK = theme.palette.dark.ground;
const LIGHT = theme.palette.light.ground;
// The two theme-color metas of public/index.html, in its order: the light ground for a light system, then the dark
// one. The browser uses the first that matches, so the setter must write both, or a dark pick on a light system
// would keep the light bar.
const lightMeta = document.createElement('meta');
lightMeta.name = 'theme-color';
lightMeta.media = '(prefers-color-scheme: light)';
lightMeta.content = LIGHT;
document.head.appendChild(lightMeta);
const meta = document.createElement('meta');
meta.name = 'theme-color';
meta.content = DARK;
document.head.appendChild(meta);

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetThemeMode();
  Reflect.deleteProperty(window, 'matchMedia');
  delete document.documentElement.dataset.theme;
  lightMeta.content = LIGHT;
  meta.content = DARK;
});

/** Each theme-color meta's color, in document order. */
function bars(): string[] {
  return [lightMeta.content, meta.content];
}

/** A system that asks for light (and no reduced motion); jsdom has no matchMedia, which counts as dark. */
function systemLight(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: query === '(prefers-color-scheme: light)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

const PUBLIC = [
  ['/', { status: 'signedOut' }],
  ['/about', { status: 'signedOut' }],
  ['/privacy', { status: 'signedOut' }],
  ['/terms', { status: 'signedOut' }],
  ['/security', { status: 'signedOut' }],
  ['/sign-in', { status: 'signedOut' }],
  ['/totp', { status: 'mfaRequired', mfaToken: 'mfa' }],
] as const satisfies readonly (readonly [string, AuthState])[];

function renderAt(path: string, state: AuthState = { status: 'signedOut' }): HTMLElement {
  const auth = fakeAuth(state);
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth)))} location={path} />
    </Head.Provider>,
  );
  return screen.getByRole('banner');
}

function shown(): string | undefined {
  return document.documentElement.dataset.theme;
}

test.each(PUBLIC)('%s has the switch in its header, just before Sign in, a 44px square named for what it does', (path, state) => {
  const header = renderAt(path, state);
  const signIn = within(header).getByRole('link', { name: 'Sign in' });
  const toggle = within(header).getByRole('button', { name: 'Switch to light mode' });
  expect(toggle.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(toggle.parentElement).toBe(signIn.parentElement);
  expect(toggle.parentElement?.className).toBe('nav-act');
  expect(window.getComputedStyle(toggle).width).toBe('44px');
  expect(window.getComputedStyle(toggle).height).toBe('44px');
  expect(window.getComputedStyle(toggle).flexShrink).toBe('0');
  // The icon is decorative; the button's name says what it does. Focus takes the public pages' mint ring.
  expect(toggle.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(toggle.tabIndex).toBe(0);
  expect(css).toContain('.tw :focus-visible{outline:2px solid var(--mint);outline-offset:2px}');
});

test.each(PUBLIC)('with nothing picked, %s follows the system: light when it asks for light', (path, state) => {
  systemLight();
  const header = renderAt(path, state);
  expect(shown()).toBe('light');
  expect(bars()).toEqual([LIGHT, LIGHT]);
  expect(within(header).getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
});

test('with nothing picked and a dark system, the homepage is dark, named on the page so the CSS needs no guess', () => {
  renderAt('/');
  expect(shown()).toBe('dark');
  expect(bars()).toEqual([DARK, DARK]);
});

test('a pick wins over the system: dark on a light system is data-theme="dark", which the light media block skips', () => {
  systemLight();
  localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  renderAt('/about');
  expect(shown()).toBe('dark');
  // Both metas, so the light one (whose media query the light system matches) does not keep the light bar.
  expect(bars()).toEqual([DARK, DARK]);
});

test('pressing the header switch flips the mode on the page and the browser remembers it', () => {
  const header = renderAt('/');
  fireEvent.click(within(header).getByRole('button', { name: 'Switch to light mode' }));
  expect(shown()).toBe('light');
  expect(bars()).toEqual([LIGHT, LIGHT]);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  // The same control, now named for the way back.
  fireEvent.click(within(header).getByRole('button', { name: 'Switch to dark mode' }));
  expect(shown()).toBe('dark');
  expect(bars()).toEqual([DARK, DARK]);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
});

test('a pick made on one public page holds on the next, as a new page load reads it', () => {
  const header = renderAt('/privacy');
  fireEvent.click(within(header).getByRole('button', { name: 'Switch to light mode' }));
  cleanup();
  resetThemeMode();
  delete document.documentElement.dataset.theme;
  renderAt('/sign-in');
  expect(shown()).toBe('light');
});

// Every color in the public pages' CSS is a var() of a theme token (theme.color on web), so the pages switch palettes
// with the page and nothing computes a color in JS.
test('the public pages’ CSS has no color literal', () => {
  for (const sheet of [css, homeCss, mapCss, storyCss]) {
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\(/i);
  }
});

test('the map’s Northeast lines are the Northeast series color, apart from the county’s mint in light, text3 in dark', () => {
  const ne = `var(${colorVar('seriesNortheast')})`;
  expect(mapCss).toContain(`.twmap .sp-ne{fill:none;stroke:${ne};`);
  expect(mapCss).toContain(`.twmap .ln-ne{border-top:${theme.stroke.series}px dashed ${ne}}`);
  expect(mapCss).toContain(`.twmap .ch-ne{fill:none;stroke:${ne};`);
  // Dark keeps exactly the color the lines had (text3); light gets the gray that reads apart from mint.
  expect(theme.palette.dark.seriesNortheast).toBe(theme.palette.dark.text3);
  expect(theme.palette.light.seriesNortheast).not.toBe(theme.palette.light.text3);
});
