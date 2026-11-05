import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { css } from '../../src/marketing/styles.web';
import { homeCss } from '../../src/marketing/homeStyles.web';
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
const EARLY_ACCESS = '/request-access';
const CONTACT = 'mailto:hello@townwise.tech';
const ANTHROPIC_TERMS = 'https://www.anthropic.com/legal/commercial-terms';

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
          '(gate)/(app)/request-access': () => <p>Request access form</p>,
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
  expect(linksOn('/about')).toEqual([EARLY_ACCESS, CONTACT]);
  expect(linksOn('/terms')).toEqual(expect.arrayContaining(['/privacy', '/security', '#s1', '#s12', CONTACT]));
  expect(linksOn('/security')).toEqual(['/settings/security', CONTACT, '/terms']);
  expect(linksOn('/privacy')).toEqual(expect.arrayContaining(['#short', '#org', '#changes', CONTACT, ANTHROPIC_TERMS]));
});

test.each(PAGES)('every Request early access link on %s goes to the request form, and Contact is the mailto', (path) => {
  renderAt(path);
  const early = screen.getAllByRole('link', { name: 'Request early access' });
  // The header and the footer on every page, plus the page's own actions.
  expect(early.length).toBeGreaterThanOrEqual(2);
  for (const link of early) expect(link.getAttribute('href')).toBe(EARLY_ACCESS);
  expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Contact' }).getAttribute('href')).toBe(CONTACT);
  expect(document.body.textContent).not.toMatch(/write to us with your town/i);
  expect([...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '').filter((href) => href.includes('subject='))).toEqual([]);
});

// A placeholder is any bracketed text that starts with a capital ([DECISION NEEDED: …], [PRICE], [HOW: …]), or
// anything still drawn as a placeholder box. The check covers the page, its header and its footer.
test.each(['/', '/about', '/privacy'])('%s keeps Request early access in the header and the footer, to the request form', (path) => {
  renderAt(path);
  const cta = within(screen.getByRole('banner')).getByRole('link', { name: 'Request early access' });
  expect(cta.className).toBe('btn');
  expect(cta.getAttribute('href')).toBe(EARLY_ACCESS);
  const account = within(screen.getByRole('contentinfo')).getByRole('navigation', { name: 'Account' });
  expect(within(account).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Sign in', '/sign-in'], ['Request early access', EARLY_ACCESS],
  ]);
});

test.each(PAGES)('%s, header and footer included, renders no bracketed placeholder and no placeholder box', (path) => {
  renderAt(path);
  const text = document.body.textContent;
  expect(text.match(/\[[A-Z][^\]]*\]/g)).toBeNull();
  expect(document.querySelectorAll('.chip')).toHaveLength(0);
  expect(within(screen.getByRole('contentinfo')).getByText('© 2026 Townwise')).toBeTruthy();
});

test('Terms has no liability cap, notice period, governing-law clause or promise to notify account holders', () => {
  renderAt('/terms');
  const main = screen.getByRole('main');
  const text = main.textContent;
  expect(text).toContain('These terms are between you and the Townwise team, a group of students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering (“Townwise”, “we”).');
  expect(text).toContain('Townwise does not charge for early access.');
  expect(text).toContain('If we do, we will update this page and the effective date at the top before the changes take effect.');
  expect(text).toContain('or end early access for everyone. Whenever you stop');
  expect(text).not.toMatch(/total liability|governed by|tell account holders|we start charging/i);
  expect(within(main).queryByRole('heading', { name: /Governing law/ })).toBeNull();
});

test('Request early access, signed out, sends the visitor to sign in with Google first', async () => {
  renderAt('/');
  fireEvent.click(within(screen.getByRole('banner')).getByRole('link', { name: 'Request early access' }));
  expect(await screen.findByText('Sign-in screen')).toBeTruthy();
  expect(window.location.pathname).toBe('/sign-in');
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

test('Privacy names Anthropic as the tuning chat’s provider, says the chat is off until turned on, and links Anthropic’s terms', () => {
  renderAt('/privacy');
  const items = within(screen.getByRole('region', { name: 'Who else sees it' })).getAllByRole('listitem');
  const anthropic = items.find((item) => item.textContent.startsWith('Anthropic,'));
  if (anthropic === undefined) throw new Error('no Anthropic item');
  expect(anthropic.textContent).toContain('The tuning chat is off in production until we turn it on, and while it is off nothing is sent to Anthropic.');
  expect(anthropic.textContent).toContain('Anthropic receives the messages you send and the location data the assistant reads to answer them');
  expect(anthropic.textContent).toContain('which say Anthropic may not train models on that content.');
  expect(within(anthropic).getByRole('link', { name: 'Commercial Terms of Service' }).getAttribute('href')).toBe(ANTHROPIC_TERMS);
  expect(anthropic.querySelectorAll('.chip')).toHaveLength(0);
});

test('Privacy makes the three commitments and no longer says the app has no upload', () => {
  renderAt('/privacy');
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Townwise does not sell personal data.');
  expect(text).toContain('Your sales data is used only to provide Townwise to your restaurant: its own forecasts and, when it is turned on, its tuning chat. It is not shared with or used for other restaurants, and it is not used to train AI models.');
  expect(text).toContain('The operator responsible for your data is the Townwise team, a group of students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering in Hanover, NH. Townwise is not an official Dartmouth product.');
  expect(text).toContain('we will delete your account and its data within 30 days');
  expect(text).toContain('sends us only the date, guest count and net sales for each day');
  expect(text).toContain('Effective November 5, 2026. Last updated November 5, 2026.');
  expect(text).not.toMatch(/no place to upload|before any upload exists|email account holders/i);
});

test('on phones the Privacy tables stack into rows, each cell after the first labeled with its column name', () => {
  renderAt('/privacy');
  const tables = [...document.querySelectorAll('.pg-privacy .tbl table')];
  expect(tables).toHaveLength(2);
  for (const table of tables) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    for (const row of table.querySelectorAll('tbody tr')) {
      expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-l'))).toEqual([null, ...heads.slice(1)]);
    }
  }
  expect(css).toContain('.pg-privacy .tbl table,.pg-privacy .tbl.wide table{min-width:0;font-size:16px;line-height:24px}');
  expect(css).toContain('.pg-privacy .tbl td[data-l]::before{content:attr(data-l);');
});

test('on phones the Privacy and Terms contents keep two columns', () => {
  expect(css).toContain('@media (max-width:640px){.pg-privacy .toc{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px}}');
  expect(css).not.toContain('.pg-terms .toc ol{grid-template-columns:minmax(0,1fr)}');
});

test('below 360px the header tightens, shrinking the wordmark only beside the early-access button', () => {
  expect(css).toContain('@media (max-width:359px){.nav-in{column-gap:8px}.nav-in:has(.btn)>.wm{font-size:16px}.nav-act{gap:8px}.nav-act .btn{font-size:13px;padding:0 10px}}');
});

test('on phones a link in running text gets a 44px-tall tap target', () => {
  for (const page of ['privacy', 'terms', 'security']) {
    expect(css).toContain(`@media (max-width:640px){.pg-${page} .prose a{position:relative;z-index:1;padding-block:13px}`);
  }
  expect(homeCss).toContain('@media (max-width:640px){.pg-home .faq-i p a{position:relative;z-index:1;padding-block:13px}}');
});

test('marketing text keeps its set size when a phone turns sideways', () => {
  const tw = /^\.tw\{([^}]*)\}$/m.exec(css)?.[1]?.split(';') ?? [];
  expect(tw).toEqual(expect.arrayContaining(['-webkit-text-size-adjust:100%', 'text-size-adjust:100%']));
});

test('Terms and Security carry the new date, and Security says where Townwise is hosted', () => {
  renderAt('/terms');
  expect(screen.getByText('Effective November 5, 2026.')).toBeTruthy();
  expect(screen.getByRole('main').textContent).toContain('you must be 18 or older and acting for your business');
  cleanup();
  renderAt('/security');
  expect(screen.getByText('Last updated November 5, 2026')).toBeTruthy();
  const hosting = screen.getByRole('main').textContent;
  expect(hosting).toContain('Our server and its database run on Microsoft Azure, in its East US region');
  expect(hosting).not.toContain('Hosting has not been chosen');
  expect(within(screen.getByRole('main')).getByRole('link', { name: 'hello@townwise.tech' }).getAttribute('href')).toBe(CONTACT);
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
