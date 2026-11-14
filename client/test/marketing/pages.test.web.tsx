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

test('Privacy names Anthropic as TownwiseAI’s provider, says nothing is sent unless you use it, and links Anthropic’s terms', () => {
  renderAt('/privacy');
  const items = within(screen.getByRole('region', { name: 'Who else sees it' })).getAllByRole('listitem');
  const anthropic = items.find((item) => item.textContent.startsWith('Anthropic,'));
  if (anthropic === undefined) throw new Error('no Anthropic item');
  expect(anthropic.textContent).toContain('which provides the AI model behind TownwiseAI, the assistant on each location’s TownwiseAI page. Nothing is sent to Anthropic unless you use it, or Townwise staff setting up your organization for you before anyone from it joins use it (see Who can see it, under Your restaurant’s sales data).');
  // D25: staff in open as admin can run TownwiseAI and drop files, so neither sentence may say only “you”.
  expect(anthropic.textContent).not.toContain('Nothing is sent to Anthropic unless you use it.');
  expect(anthropic.textContent).toContain('when you, or staff setting it up for you, drop a file');
  expect(anthropic.textContent).not.toContain('off in production');
  expect(anthropic.textContent).toContain('Anthropic receives the messages you send and the location data the assistant reads to answer them');
  expect(anthropic.textContent).toContain('its notes, its forecast’s ranges and accuracy and its calibration results, its town profile');
  expect(anthropic.textContent).toContain('which say Anthropic may not train models on that content.');
  expect(within(anthropic).getByRole('link', { name: 'Commercial Terms of Service' }).getAttribute('href')).toBe(ANTHROPIC_TERMS);
  expect(anthropic.querySelectorAll('.chip')).toHaveLength(0);
});

test('Privacy describes how forecasts are built and what Townwise keeps', () => {
  renderAt('/privacy');
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Forecasts. Townwise builds your forecasts from your sales history and notes on Townwise’s own servers, in a job that sees only that location’s days. The model it fits learns only from your restaurant and is used only for your restaurant; Townwise keeps the results (a range of guests per day, the dates the model learned from, and how accurate it has been) and not the model. When Townwise staff import a forecast instead, it was built on the team’s own computers from sales exports you sent us; that model and those exports stay with Townwise staff, are used only for your restaurant, and are deleted when your organization is deleted or when you ask. You and TownwiseAI see the results. Deleting your sales data or your organization deletes them.');
});

test('Privacy says what letting TownwiseAI read a file sends, adds and keeps, and no line says files are never read (D34)', () => {
  renderAt('/privacy');
  const sales = [...screen.getByRole('region', { name: 'Your restaurant’s sales data' }).querySelectorAll('p')].map((p) => p.textContent);
  const paragraph = sales.find((line) => line.startsWith('Files you let TownwiseAI read.'));
  expect(paragraph).toBe('Files you let TownwiseAI read. Townwise never sends a file you add to an AI model unless you ask, one file at a time: the box under Add a file, or “Let TownwiseAI read this file” on the file’s page, is off until you choose it. Then Townwise sends that whole file to Anthropic’s Claude, with today’s date and your location’s time zone, and nothing else: not the file’s name, your organization’s or location’s name, or anyone’s email. A point-of-sale export sent this way can hold diner or staff names, and Claude reads all of it; TownwiseAI is told not to repeat a person’s name, email or phone number. TownwiseAI adds what it finds to your account: dated events as notes, daily totals it can check against the file’s own text as sales days, and a summary on Your data it can read later; when an org admin asks, it may also start updating the forecast. Everything it adds can be undone from the file’s page; a forecast update it started keeps running and goes live only once Townwise turns forecasts on for you. What Claude found is kept with the file until you undo the read or the file’s original is deleted; the notes and sales days TownwiseAI added stay until you undo the read or delete them yourself, and its summary on Your data is kept like any item added for reference.');
  // The lead-in is bold, as the section's other paragraphs have theirs.
  const lead = [...screen.getByRole('region', { name: 'Your restaurant’s sales data' }).querySelectorAll('p')].find((p) => p.textContent.startsWith('Files you let'));
  expect(lead?.firstElementChild?.textContent).toBe('Files you let TownwiseAI read.');
  // It follows the paragraph that points to it.
  expect(sales.indexOf(paragraph ?? '')).toBe(sales.findIndex((line) => line.startsWith('Your files are personal data too.')) + 1);
  const anthropic = within(screen.getByRole('region', { name: 'Who else sees it' })).getAllByRole('listitem').find((item) => item.textContent.startsWith('Anthropic,'));
  expect(anthropic?.textContent).toContain('When you let TownwiseAI read a file, the whole file is sent to it.');
  expect(anthropic?.textContent).toContain('Townwise never sends it your team’s names or email addresses, apart from any in a file you let it read.');
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Notes and other text in your files are stored but never read, unless you let TownwiseAI read the file.');
  expect(text).not.toMatch(/TownwiseAI never reads the sales files you drop\./);
  expect(text).not.toMatch(/stored but never read\./);
});

test('Privacy says notes hold optional hours and change the published forecast (spec 17, D30)', () => {
  renderAt('/privacy');
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Notes. Notes about unusual days: the kind, the dates and weekdays, the hours if you give them, the expected effect and number of guests, a detail of up to 280 characters, and who wrote it. Everyone on your organization’s team can see them. Home, the Calendar and Analytics show them beside your days, and TownwiseAI reads them. From today on, a private event with a number of guests, a buyout or a closure changes your location’s published forecast for its days; a note’s detail never goes into the forecast.');
});

test('Privacy makes the three commitments and no longer says the app has no upload', () => {
  renderAt('/privacy');
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Townwise does not sell personal data.');
  expect(text).toContain('Your sales data is used only to provide Townwise to your restaurant: its own forecasts and TownwiseAI, its AI assistant. It is not shared with or used for other restaurants. It trains only your own location’s forecast model, and it is never used to train AI models such as TownwiseAI’s.');
  expect(text).not.toContain('tuning chat');
  expect(text).toContain('The operator responsible for your data is the Townwise team, a group of students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering in Hanover, NH. Townwise is not an official Dartmouth product.');
  expect(text).toContain('we will delete your account and its data within 30 days');
  expect(text).toContain('sends us only the date, guest count and net sales for each day');
  expect(text).toContain('Effective November 5, 2026. Last updated November 14, 2026.');
  // D25: open as admin before anyone joins, then view-as only.
  expect(text).toContain('Before anyone from your organization has joined Townwise, staff setting it up for you, with your consent, can open it as its admin: they see and change what an admin can, except your team, until the first person joins. Each time, and every change they make, is recorded and shown to your organization’s admins.');
  expect(text).toContain('Once anyone has joined, Townwise staff can see the sales figures and your location notes only through view-as');
  expect(text).toContain('uploads, TownwiseAI messages, and staff view-as and open as admin for one hour');
  expect(text).toContain('public facts about its town (its calendar, and who is likely in town, with the public sources behind them). TownwiseAI never reads the sales files you drop unless you let it read one. It reads a text item on Your data, text you pasted or a text file you added, only when you ask, and never a file’s name.');
  expect(text).toContain('Turning an item off leaves it out of your numbers, forecasts and TownwiseAI until someone turns it back on.');
  expect(text).toContain('Items you add for reference follow the same rules: we delete each one 365 days after it was sent, or sooner when you delete it.');
  // Your data as the app gives it: an item's original downloads to the person who added it and org admins only, and
  // an org admin's "Delete all originals for this location" on P26 leaves items kept for reference whole.
  expect(text).toContain('Everyone on your organization’s team can see them; the person who added one and your org admins can download it.');
  expect(text).not.toContain('can see and download them');
  expect(text).toContain('only an org admin can delete an upload, which deletes the days it still holds. For a sales file, they can instead delete just its original and keep its cleaned daily totals, and an org admin can delete all originals for a location at once and keep the cleaned daily totals; items added for reference stay.');
  expect(text).toContain('we delete your organization’s originals, items you added for reference included, and keep the cleaned totals.');
  expect(text).toContain('For a file you drop for your sales history, unless you let TownwiseAI read that file (below), we never read those fields, and only the three values a day leave it.');
  expect(text).toContain('Notes, uploads and items on Your data that you added stay with your organization, including text you kept from TownwiseAI.');
  expect(text).toContain('Answers are deleted with the location’s sales data, the location or the organization.');
  // Stored files (privacy pass 2), Google Places and Maps (1b) and the welcome marker (1c).
  expect(text).not.toContain('The file itself never reaches our server');
  expect(text).toContain('we delete each original 365 days after it was sent, or sooner when you delete it');
  expect(text).toContain('never its rows, its name or your restaurant’s name');
  expect(text).toContain('A deleted file can be recovered by us for 7 days, then it is gone.');
  expect(text).toContain('When a found place shows a map, your browser or app loads the map image straight from Google, so Google sees your IP address. We keep Google’s id for the place, and on an access request its name and town too.');
  expect(text).toContain('If you find your business on Google Maps, we also keep Google’s id, name and town for each place you check, not its address or the map.');
  expect(text).toContain('When you first open Townwise after approval, we note that we showed you the welcome, and when.');
  expect(text).toContain('the proposal’s wording stays only in your conversation, and in your notes if you save it.');
  expect(text).not.toMatch(/no place to upload|before any upload exists|email account holders/i);
});

test('Privacy says which two emails Townwise sends, through whom, and that it keeps only a log line with ids', () => {
  renderAt('/privacy');
  const email = [...screen.getByRole('region', { name: 'Email' }).querySelectorAll('p')].map((p) => p.textContent);
  expect(email[0]).toBe('Townwise sends two emails, each only to the person it concerns: “request received”, after you send an access request, and “you’re in”, after Townwise staff approve it. They come from no-reply@townwise.tech through Microsoft’s Azure Communication Services, with open and click tracking off. Each holds your organization’s name, its town and the address you sign in with, never sales figures, files or notes. Townwise sends no other email, for sign-in, invitations or anything else.');
  expect(email[1]).toContain('Townwise keeps nothing about a send except one line in our server log: which email it was, the ids of the access request and, for “you’re in”, the organization, and an error code if it failed, never your address.');
  const text = screen.getByRole('main').textContent;
  expect(text).not.toContain('Townwise does not send email');
  expect(text).toContain('Townwise does not email them.');
  const items = within(screen.getByRole('region', { name: 'Who else sees it' })).getAllByRole('listitem');
  expect(items.find((item) => item.textContent.startsWith('Microsoft Azure,'))?.textContent).toContain('delivers our two emails through Azure Communication Services');
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

test('sign-in fills the window under the header, centered, so the footer starts below the fold', () => {
  // .tw is absolutely positioned over the window, so main's percentage is of the window's height; the header is
  // 64px and its 1px border. No viewport units.
  expect(css).toContain('.tw main:has(>.pg-signin){display:grid;min-height:calc(100% - 65px)}');
  expect(css).toContain('.pg-signin{display:grid;align-content:center}');
  expect(css).toMatch(/\.tw\{[^}]*position:absolute;inset:0;/);
  expect(css).toContain('.nav-in{display:flex;flex-wrap:wrap;align-items:center;column-gap:48px;min-height:64px}');
  expect(css).toContain('.nav{border-bottom:1px solid var(--border)}');
});

test('the light and dark switch sits 8px before Sign in, as in the portal’s bar, and the button 20px after it', () => {
  expect(css).toContain('.nav-act{margin-left:auto;display:flex;align-items:center;gap:8px}\n.nav-act .btn{margin-left:12px}');
});

test('on phones the header stays one row: the early-access label wraps inside its 44px before the row would', () => {
  // Up to 420px the gap after the wordmark and the button's padding tighten, which keeps the label on one line down
  // to 388px (the common 390px phones). Under that the wordmark, the switch, Sign in and the one-line button do not
  // fit side by side. The row does not wrap; Sign in and the switch keep their size and the label takes two lines.
  expect(css).toContain('@media (max-width:640px){.nav-in{flex-wrap:nowrap;column-gap:12px}.nav-links{display:none}.nav-act .tl{flex-shrink:0}.nav-act .btn{margin-left:4px;font-size:14px;padding:0 14px;white-space:normal;text-align:center;line-height:16px}}\n@media (max-width:420px){.nav-in{column-gap:8px}.nav-act .btn{padding:0 10px}}');
});

test('below 360px the header tightens, shrinking the wordmark only beside the early-access button', () => {
  expect(css).toContain('@media (max-width:359px){.nav-in{column-gap:8px}.nav-in:has(.btn)>.wm{font-size:16px}.nav-act .btn{margin-left:0;font-size:13px;padding:0 10px}}');
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
  expect(screen.getByText('Effective November 9, 2026.')).toBeTruthy();
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
