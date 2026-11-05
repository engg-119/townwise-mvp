import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import MarketingHome from '../../app/(marketing)/index';
import About from '../../app/(marketing)/about';
import Privacy from '../../app/(marketing)/privacy';
import Terms from '../../app/(marketing)/terms';
import PublicSecurity from '../../app/(marketing)/security';
import AuthGate from '../../app/(gate)/_layout';
import AppLayout from '../../app/(gate)/(app)/_layout';
import { fakeAuth } from '../helpers/fakes';
import { brokenHref } from '../helpers/routes';

const PAGES = ['/', '/about', '/privacy', '/terms', '/security'];
const EARLY_ACCESS = 'mailto:hello@townwise.tech?subject=Townwise%20early%20access';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom does not scroll; record which element each scroll was for.
let scrolledTo: string[] = [];
beforeEach(() => {
  scrolledTo = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void { scrolledTo.push(this.id); };
});

afterEach(() => {
  cleanup();
});

// The web entry wraps the app in Head's provider (expo-router's qualified-entry); the tests do the same.
function renderAt(path: string): void {
  const auth = fakeAuth({ status: 'signedOut' });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({
          _layout: () => <AuthProvider auth={auth}><RootStack /></AuthProvider>,
          '(marketing)/_layout': MarketingLayout,
          '(marketing)/index': MarketingHome,
          '(marketing)/about': About,
          '(marketing)/privacy': Privacy,
          '(marketing)/terms': Terms,
          '(marketing)/security': PublicSecurity,
          '(gate)/_layout': AuthGate,
          '(gate)/sign-in': () => <p>Sign-in screen</p>,
          '(gate)/totp': () => null,
          '(gate)/auth/magic': () => null,
          '(gate)/(app)/_layout': AppLayout,
          '(gate)/(app)/dashboard': () => null,
          '(gate)/(app)/settings/security': () => null,
        })}
        location={path}
      />
    </Head.Provider>,
  );
}

test.each(PAGES)('%s renders the skip link, header, main and footer', (path) => {
  renderAt(path);
  expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main');
  const header = screen.getByRole('banner');
  expect(within(header).getByRole('link', { name: 'Townwise' }).getAttribute('href')).toBe('/');
  expect(within(header).getByRole('navigation', { name: 'Main' })).toBeTruthy();
  expect(screen.getByRole('main').id).toBe('main');
  const footer = screen.getByRole('contentinfo');
  for (const group of ['Product', 'Company', 'Legal', 'Account']) {
    expect(within(footer).getByRole('navigation', { name: group })).toBeTruthy();
  }
  expect(footer.querySelector('.ft-word')?.textContent).toBe('TOWNWISE');
  expect(within(footer).getByText('Townwise is a student project. It is not an official Dartmouth product.')).toBeTruthy();
});

test.each(PAGES)('every link on %s resolves', (path) => {
  renderAt(path);
  const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
  const hrefs = [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');
  expect(hrefs.length).toBeGreaterThanOrEqual(19);
  expect(hrefs.map((href) => brokenHref(href, ids)).filter((problem) => problem !== null)).toEqual([]);
});

test('the text pages link to each other, to the app and by email', () => {
  const linksOn = (path: string): string[] => {
    renderAt(path);
    const hrefs = [...screen.getByRole('main').querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');
    cleanup();
    return hrefs;
  };
  expect(linksOn('/about')).toEqual([EARLY_ACCESS, 'mailto:hello@townwise.tech']);
  expect(linksOn('/terms')).toEqual(expect.arrayContaining(['/privacy', '/security', '#s1', '#s13', 'mailto:hello@townwise.tech']));
  expect(linksOn('/security')).toEqual(['/settings/security', '/terms']);
  expect(linksOn('/privacy')).toEqual(expect.arrayContaining(['#short', '#changes', 'mailto:hello@townwise.tech']));
});

test('the mailto links are exact', () => {
  renderAt('/about');
  const early = screen.getAllByRole('link', { name: 'Request early access' });
  expect(early).toHaveLength(3);
  for (const link of early) expect(link.getAttribute('href')).toBe(EARLY_ACCESS);
  expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Contact' }).getAttribute('href'))
    .toBe('mailto:hello@townwise.tech');
});

test('a footer link navigates in the app', async () => {
  renderAt('/about');
  fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Privacy' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/privacy'); });
  expect(screen.getByRole('heading', { name: 'Privacy' })).toBeTruthy();
});

test('Sign in goes to /sign-in, with no sign-up page anywhere', async () => {
  renderAt('/');
  expect(screen.queryByText(/sign up/i)).toBeNull();
  const signIn = within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' });
  expect(signIn.getAttribute('href')).toBe('/sign-in');
  fireEvent.click(signIn);
  expect(await screen.findByText('Sign-in screen')).toBeTruthy();
  expect(window.location.pathname).toBe('/sign-in');
});

test('a section link from another page goes to / and scrolls to the section', async () => {
  renderAt('/about');
  fireEvent.click(within(screen.getByRole('banner')).getByRole('link', { name: 'How it works' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/'); });
  await waitFor(() => { expect(scrolledTo).toEqual(['how']); });
  expect(document.activeElement?.id).toBe('how');
});

test('a section link on the homepage scrolls without navigating', () => {
  renderAt('/');
  fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'FAQ' }));
  expect(scrolledTo).toEqual(['faq']);
  expect(document.activeElement?.id).toBe('faq');
  expect(window.location.pathname).toBe('/');
  expect(screen.getAllByRole('main')).toHaveLength(1);
});

test('the skip link moves focus to main', () => {
  renderAt('/terms');
  fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
  expect(document.activeElement).toBe(screen.getByRole('main'));
});

test('an On this page link scrolls to its section', () => {
  renderAt('/privacy');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'On this page' })).getByRole('link', { name: 'Cookies' }));
  expect(scrolledTo).toEqual(['cookies']);
  expect(document.activeElement?.id).toBe('cookies');
});

test('a deep link to a section lands on it', async () => {
  renderAt('/privacy#cookies');
  await act(() => Promise.resolve());
  expect(scrolledTo).toEqual(['cookies']);
});

test('a link to the page you are on goes back to its top', () => {
  renderAt('/about');
  const root = screen.getByRole('main').parentElement;
  if (root === null) throw new Error('no scroll container');
  root.scrollTop = 500;
  fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'About' }));
  expect(root.scrollTop).toBe(0);
  expect(window.location.pathname).toBe('/about');
});

test.each([
  ['/', 'Townwise'],
  ['/about', 'Townwise About'],
  ['/privacy', 'Townwise Privacy'],
  ['/terms', 'Townwise Terms'],
  ['/security', 'Townwise Security'],
])('%s has its own document title', async (path, title) => {
  document.title = '';
  renderAt(path);
  await waitFor(() => { expect(document.title).toBe(title); });
});

test('the title follows the page shown, and a screen with none gets the site title', async () => {
  renderAt('/about');
  await waitFor(() => { expect(document.title).toBe('Townwise About'); });
  fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Privacy' }));
  await waitFor(() => { expect(document.title).toBe('Townwise Privacy'); });
  fireEvent.click(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' }));
  expect(await screen.findByText('Sign-in screen')).toBeTruthy();
  await waitFor(() => { expect(document.title).toBe('Townwise'); });
});

// The stack keeps earlier pages mounted (hidden), so a heading id another page also uses would name
// the shown page's sections after the hidden page's heading.
test.each([
  ['/about', 'Where your data lives'],
  ['/security', 'What we keep when you sign in'],
])('after %s, Privacy names its sections by its own headings', async (from, name) => {
  renderAt(from);
  fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Privacy' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/privacy'); });
  expect(screen.getAllByRole('main', { hidden: true }).length).toBeGreaterThan(1);
  expect(screen.getByRole('region', { name })).toBeTruthy();
  const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index && /^h-|^pv-/.test(id))).toEqual([]);
});

test('Privacy names Anthropic as the tuning chat’s provider, with its retention and training wording undecided', () => {
  renderAt('/privacy');
  const items = within(screen.getByRole('region', { name: 'Who else sees it' })).getAllByRole('listitem');
  const anthropic = items.find((item) => item.textContent.startsWith('Anthropic,'));
  if (anthropic === undefined) throw new Error('no Anthropic item');
  expect(anthropic.textContent).toContain('Anthropic receives the messages you send and the location data the assistant reads to answer them');
  expect([...anthropic.querySelectorAll('.chip')].map((chip) => chip.textContent)).toEqual([
    '[DECISION NEEDED: how long Anthropic keeps chat data, and whether it may be used to train models]',
  ]);
});

test('About lists what we are building in the future tense, then what comes next, unnumbered', () => {
  renderAt('/about');
  const items = [...within(screen.getByRole('region', { name: 'What we’re building' })).getAllByRole('listitem')];
  expect(items.map((item) => item.textContent)).toEqual([
    'A research agent that will find every event and driver of demand in a town, with the date and the public source behind each one.',
    'Uploading your sales history from your point-of-sale system, to calibrate your forecasts.',
    'A model calibrated to your business: the town model, tuned with your own history to forecast your daily guests and sales, each day with a range and a reason.',
    'A tuning agent you talk to: tell it what it can’t see, and it will retrain your model and explain its forecasts.',
    'An app that will put it in front of the people who place the orders.',
    'Next: reorder suggestions, starting with bar inventory.',
  ]);
  expect(items.map((item) => item.className)).toEqual(['', '', '', '', '', 'nx']);
});
