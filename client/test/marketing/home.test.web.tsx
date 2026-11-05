import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import MarketingLayout from '../../app/(marketing)/_layout';
import MarketingHome from '../../app/(marketing)/index';
import { navLinks } from '../../src/marketing/links';
import { FLOW, homeCss } from '../../src/marketing/homeStyles.web';

const TITLE = 'The Northeast has one season. Your town has its own.';
const EARLY_ACCESS = '/request-access';
const SECTIONS: readonly [string, string][] = [
  ['map', TITLE],
  ['problem', 'A regional forecast averages your town away.'],
  ['how', 'Local first. Then your own numbers.'],
  ['product', 'Two horizons. A range. A reason.'],
  ['who', 'Independent restaurants and bars in towns that keep their own calendar.'],
  ['about', 'About'],
  ['faq', 'FAQ'],
  ['start', 'Tell us about your town.'],
];

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom has neither IntersectionObserver nor matchMedia, so each test installs the ones it needs.
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeObserver.instances.push(this);
  }

  observe(target: Element): void { this.observed.push(target); }
  unobserve(): void { return undefined; }
  disconnect(): void { this.disconnected = true; }
  takeRecords(): IntersectionObserverEntry[] { return []; }

  report(isIntersecting: boolean, intersectionRatio: number): void {
    const entries = this.observed.map((target) => ({ target, isIntersecting, intersectionRatio }) as IntersectionObserverEntry);
    act(() => { this.callback(entries, this as unknown as IntersectionObserver); });
  }
}

function installObserver(): void {
  Object.defineProperty(window, 'IntersectionObserver', { configurable: true, writable: true, value: FakeObserver });
}

function prefersReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: reduce && media === '(prefers-reduced-motion: reduce)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

afterEach(() => {
  cleanup();
  FakeObserver.instances = [];
  Reflect.deleteProperty(window, 'IntersectionObserver');
  Reflect.deleteProperty(window, 'matchMedia');
});

function renderHome(): HTMLElement {
  window.history.replaceState(null, '', '/');
  // The web entry wraps the app in Head's provider (expo-router's qualified-entry).
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({ '(marketing)/_layout': MarketingLayout, '(marketing)/index': MarketingHome })}
        location="/"
      />
    </Head.Provider>,
  );
  return screen.getByRole('main');
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function revealed(name: string): HTMLElement {
  const wrap = section(name).querySelector<HTMLElement>(':scope > .rv');
  if (wrap === null) throw new Error(`no reveal wrapper in ${name}`);
  return wrap;
}

// The observer that watches a section's reveal wrapper.
function observerOf(wrap: Element): FakeObserver {
  const found = FakeObserver.instances.find((observer) => observer.observed.includes(wrap));
  if (found === undefined) throw new Error('no observer for the section');
  return found;
}

function follows(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

test('the first screen is the map story’s title with both actions; the lead follows the story, then the list', () => {
  const main = renderHome();
  const hero = section(TITLE);
  expect(main.querySelector('section')).toBe(hero);
  const wrap = hero.firstElementChild;
  expect([...(wrap?.children ?? [])].map((child) => child.className)).toEqual(['twmap']);
  // Step 0 of the story: the title, the subtitle (what we are building, not a claim that forecasts exist) and
  // both actions.
  const head = hero.querySelector('.st-h > .hd');
  expect([...(head?.children ?? [])].map((child) => [child.tagName, child.textContent])).toEqual([
    ['H1', TITLE],
    ['P', 'We’re building daily demand forecasts for restaurants and bars in college, ski and island towns. Now in early access.'],
    ['DIV', 'Request early accessSign in'],
  ]);
  // After the story: the eyebrow, the sub, both actions again and the status line.
  const lead = hero.querySelector('.hd2');
  expect([...(lead?.children ?? [])].map((child) => [child.tagName, child.textContent])).toEqual([
    ['P', 'Early access. Built at Dartmouth, testing in Hanover, NH.'],
    ['P', 'We’re building forecasts of daily guests and sales for restaurants and bars, 7 and 28 days ahead, from your town’s calendar, not the region’s.'],
    ['DIV', 'Request early accessSign in'],
    ['P', 'In development. No forecasts are for sale yet.'],
  ]);

  const title = screen.getByRole('heading', { level: 1, name: TITLE });
  const [early, earlyAgain] = within(hero).getAllByRole('link', { name: 'Request early access' });
  const [signIn, signInAgain] = within(hero).getAllByRole('link', { name: 'Sign in' });
  const map = within(hero).getByRole('img', { name: /^Map of the nine Northeast states/ });
  const steps = ['The Northeast, as one pattern.', 'Now the towns.', 'July, the year’s widest spread.'].map((name) => within(hero).getByRole('heading', { level: 2, name }));
  const pick = within(hero).getByRole('heading', { level: 2, name: 'Pick a town to compare it with the Northeast' });
  const list = within(hero).getByRole('button', { name: /^Hanover, NH/ });
  if (early === undefined || earlyAgain === undefined || signIn === undefined || signInAgain === undefined) throw new Error('missing actions');
  expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);
  const order = [title, early, signIn, map, ...steps, earlyAgain, signInAgain, pick, list];
  for (const [index, element] of order.slice(1).entries()) expect(follows(order[index] ?? element, element)).toBe(true);
});

test('the hero actions, under the title and again after the story: Request early access as the white primary, Sign in as the outline, both kept on phones', () => {
  renderHome();
  const rows = [...section(TITLE).querySelectorAll<HTMLElement>('.cta-row')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(within(row).getAllByRole('link').map((link) => [link.textContent, link.className, link.getAttribute('href')])).toEqual([
      ['Request early access', 'btn', EARLY_ACCESS],
      ['Sign in', 'btn-o', '/sign-in'],
    ]);
  }
  // Phones share the row between the two; nothing hides the outline Sign in.
  expect(homeCss).toContain('@media (max-width:640px){.pg-home .hero{padding-bottom:64px}.pg-home .hd{padding-block:24px}.pg-home .hd2{padding-block:32px;gap:12px}.pg-home .sub{font-size:16px;line-height:24px}.pg-home .cta-row{width:100%}.pg-home .cta-row>a{flex:1 1 auto}}');
  expect(homeCss).not.toMatch(/(?:cta-row|btn-o)[^{}]*\{[^}]*display:\s*none/);
  expect(homeCss).toContain('.pg-home .btn-o:active{transform:scale(.97)}');
});

test('the lead after the story rises in like a section, and focus inside it shows it at once', () => {
  installObserver();
  const main = renderHome();
  const lead = section(TITLE).querySelector<HTMLElement>('.hd2');
  if (lead === null) throw new Error('no lead');
  expect(lead.className).toBe('hd2 rv is-hid');
  const observer = observerOf(lead);
  expect(observer.options).toEqual({ root: main.parentElement, threshold: 0, rootMargin: '0px 0px -12% 0px' });
  act(() => { within(lead).getByRole('link', { name: 'Sign in' }).focus(); });
  expect(lead.className).toBe('hd2 rv is-now');
});

test('every action on the page has one destination per label, and there is no sign-up', () => {
  const main = renderHome();
  const early = screen.getAllByRole('link', { name: 'Request early access' });
  // The nav, the story's title step, the lead after the story, Who it is for, the final band and the footer.
  expect(early).toHaveLength(6);
  for (const link of early) expect(link.getAttribute('href')).toBe(EARLY_ACCESS);
  const signIn = screen.getAllByRole('link', { name: /sign in/i });
  expect(signIn.map((link) => link.textContent)).toEqual(['Sign in', 'Sign in', 'Sign in', 'Already have access? Sign in', 'Sign in']);
  for (const link of signIn) expect(link.getAttribute('href')).toBe('/sign-in');
  expect(screen.queryByText(/sign up/i)).toBeNull();
  expect(within(section('About')).getByRole('link', { name: 'About' }).getAttribute('href')).toBe('/about');
  expect(within(main).getByRole('link', { name: 'Privacy notice' }).getAttribute('href')).toBe('/privacy');
});

test('the sections follow ConsoleV2’s order, each named by its heading, with the anchors the nav links to', () => {
  const main = renderHome();
  const sections = [...main.querySelectorAll<HTMLElement>('.pg-home > section')];
  expect(sections.map((element) => element.id)).toEqual(SECTIONS.map(([id]) => id));
  for (const [id, name] of SECTIONS) {
    const element = section(name);
    expect(element.id).toBe(id);
    const label = document.getElementById(element.getAttribute('aria-labelledby') ?? '');
    expect(label?.closest('section')).toBe(element);
  }
  // The heading ids are prefixed, so no other mounted page's h-hero or h-about takes the label.
  expect(document.getElementById('h-hero')).toBeNull();
  for (const link of navLinks) {
    const target = main.querySelector<HTMLElement>(`[id="${link.href.replace('/#', '')}"]`);
    // Focusable, so a section link moves focus there (an element without the attribute also reads tabIndex -1).
    expect(target?.tagName).toBe('SECTION');
    expect(target?.getAttribute('tabindex')).toBe('-1');
  }
  expect(navLinks.map((link) => link.href)).toEqual(['/#map', '/#how', '/#product', '/#faq']);
});

test('How it works shows its four steps statically, with step 01’s public Hanover dates and source', () => {
  renderHome();
  const how = section('Local first. Then your own numbers.');
  const steps = [...how.querySelectorAll<HTMLElement>('.steps > li')];
  expect(steps.map((step) => within(step).getByRole('heading', { level: 3 }).textContent)).toEqual([
    'Research the town', 'Build the forecast', 'Calibrate with your sales', 'Turn the forecast into orders',
  ]);
  expect(steps.map((step) => step.querySelector('.step-bar')?.textContent)).toEqual(['01In progress', '02In progress', '03In progress', '04Planned']);
  for (const step of steps) expect(step.querySelector('.hv')?.getAttribute('aria-hidden')).toBe('true');
  const [first] = steps;
  if (first === undefined) throw new Error('no steps');
  expect([...first.querySelectorAll('.sr-only li')].map((item) => item.textContent)).toEqual([
    'Fall term classes begin, Sep 14, 2026', 'Fall term classes end, Nov 17, 2026', 'Winter term classes begin, Jan 5, 2027',
  ]);
  const source = within(first).getByRole('link', { name: 'registrar.dartmouth.edu' });
  expect(source.getAttribute('href')).toBe('https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates');
  expect(how.querySelector('.after')?.textContent).toBe('Forecasts we report as results are frozen before their outcomes are known, then scored afterward. Tests on past data are labeled as backtests.');
});

test('what is not built yet is described in the future tense', () => {
  renderHome();
  const how = section('Local first. Then your own numbers.');
  expect(how.querySelector('.steps > li .step-body p:nth-of-type(2)')?.textContent)
    .toBe('Today: Hanover’s calendar is compiled from public sources, every date with a source. The agent that will do this research on its own is not built yet.');
  const faq = within(section('FAQ'));
  expect(faq.getByText(/^If your system forecasts/).textContent).toContain('Townwise starts from your town: a research agent will find the local events that move demand, then your own sales history will calibrate the model to your business, and you will be able to tune it by talking to it.');
  expect(document.body.textContent).not.toMatch(/no upload/i);
});

test('step 03 and the FAQ say what the portal does today: uploads and notes, no forecasts', () => {
  renderHome();
  const how = section('Local first. Then your own numbers.');
  const third = [...how.querySelectorAll<HTMLElement>('.steps > li')][2];
  if (third === undefined) throw new Error('no step 03');
  expect(third.querySelector('.step-body p:nth-of-type(2)')?.textContent)
    .toBe('Today: restaurants with early access upload their daily guests and net sales in the web app, and add notes about closures and other unusual days. Calibration itself is not built yet, so the app shows no forecasts.');
  expect(third.querySelector('.chip')).toBeNull();
  const faq = within(section('FAQ'));
  expect(faq.getByText(/^Your daily guest counts/).textContent)
    .toContain('Your browser reads it and sends us only the date, guest count and net sales for each day, for one location. The file itself never reaches our server.');
  expect(faq.getByText(/^No\. Your sales data/).textContent)
    .toContain('Your sales data is used only to provide Townwise to your restaurant: its own forecasts and, when it is turned on, its tuning chat. It is not shared with or used for other restaurants, and it is not used to train AI models.');
  expect(faq.getByText(/^Townwise does not charge/).textContent).toBe('Townwise does not charge for early access. Pricing is not set yet.');
  expect(within(section('Tell us about your town.')).getByText(/^Townwise is in early access/).textContent)
    .toBe('Townwise is in early access. Sign in with Google and fill in a short form about your restaurant and your town. Someone on our team reviews each request by hand.');
});

test('the rendered text has no em or en dash and never says curve', () => {
  renderHome();
  // A chosen town adds the panel's sentences and notes.
  fireEvent.click(screen.getByRole('button', { name: /^Hanover, NH/ }));
  const text = document.body.textContent;
  const labels = [...document.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label')).join(' ');
  expect(text).toContain('In development. None of this is available to restaurants yet.');
  expect(text).toContain('Drivers');
  for (const shown of [text, labels]) {
    expect(shown).not.toMatch(/[\u2013\u2014]/);
    expect(shown).not.toMatch(/curve/i);
  }
});

test('without IntersectionObserver every section is visible', () => {
  renderHome();
  for (const [, name] of SECTIONS.slice(1)) expect(revealed(name).className).toBe('wrap g12 rv');
});

test('each section rises in once as it enters the view, and its observer then disconnects', () => {
  installObserver();
  const main = renderHome();
  const wraps = SECTIONS.slice(1).map(([, name]) => revealed(name));
  for (const wrap of wraps) {
    expect(wrap.className).toBe('wrap g12 rv is-hid');
    expect(wrap.closest('[aria-hidden="true"]')).toBeNull();
  }
  const [problem, how] = wraps;
  if (problem === undefined || how === undefined) throw new Error('no sections');
  const observer = observerOf(problem);
  expect(observer.observed).toEqual([problem]);
  expect(observer.options).toEqual({ root: main.parentElement, threshold: 0, rootMargin: '0px 0px -12% 0px' });
  observer.report(false, 0);
  expect(problem.className).toBe('wrap g12 rv is-hid');
  observer.report(true, 0.01);
  expect(problem.className).toBe('wrap g12 rv');
  expect(observer.disconnected).toBe(true);
  expect(how.className).toBe('wrap g12 rv is-hid');
  expect(homeCss).toContain('.pg-home .rv{transition:opacity 500ms var(--eo),transform 600ms var(--eo)}');
  expect(homeCss).toContain('@media (prefers-reduced-motion:no-preference){.pg-home .rv.is-hid{opacity:0;transform:translateY(16px);transition:none}}');
});

test('focus inside a hidden section shows it at once, without animating', () => {
  installObserver();
  renderHome();
  const faq = revealed('FAQ');
  act(() => { within(section('FAQ')).getByRole('link', { name: 'Privacy notice' }).focus(); });
  expect(faq.className).toBe('wrap g12 rv is-now');
  expect(homeCss).toContain('.pg-home .rv.is-now{transition:none}');
});

test('with reduced motion the sections still wait for the view, then only fade; the title fades too', () => {
  installObserver();
  prefersReducedMotion(true);
  renderHome();
  const problem = revealed('A regional forecast averages your town away.');
  expect(problem.className).toBe('wrap g12 rv is-hid');
  observerOf(problem).report(true, 0.01);
  expect(problem.className).toBe('wrap g12 rv');
  // Reduce keeps the fades and drops the movement: no translate on the sections, no rise on the title, no press.
  expect(homeCss).toContain('@media (prefers-reduced-motion:reduce){.pg-home .rv{transition:opacity 400ms var(--eo)}.pg-home .rv.is-hid{opacity:0;transition:none}.pg-home .btn-o:active{transform:none}}');
  expect(homeCss).toContain('@media (prefers-reduced-motion:reduce){.pg-home .h1.is-rise .ln>span{animation:twIn 300ms var(--eo) both}}');
  expect(homeCss).toContain('@keyframes twIn{from{opacity:0}to{opacity:1}}');
  // The map plays no year.
  expect(screen.queryByRole('button', { name: 'Play the year' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Pause the year' })).toBeNull();
});

test('the title rises once from its line masks, 600ms on the entering curve, the second sentence 80ms later', () => {
  renderHome();
  const title = screen.getByRole('heading', { level: 1, name: TITLE });
  const [first, second] = [...title.querySelectorAll<HTMLElement>('.ln > span')];
  if (first === undefined || second === undefined) throw new Error('no title lines');
  expect(title.className).toBe('h1 is-rise');
  expect(homeCss).toContain('.pg-home .h1 .ln{display:block;overflow:hidden;padding-bottom:.08em;margin-bottom:-.08em}');
  expect(homeCss).toContain('@keyframes twRise{from{transform:translateY(100%)}to{transform:none}}');
  expect(homeCss).toContain('@media (prefers-reduced-motion:no-preference){.pg-home .h1.is-rise .ln>span{animation:twRise 600ms var(--eo) both}.pg-home .h1.is-rise .ln+.ln>span{animation-delay:80ms}}');
  fireEvent.animationEnd(first);
  expect(title.className).toBe('h1 is-rise');
  // Once the last sentence lands the animation is dropped, so showing the screen again does not replay it.
  fireEvent.animationEnd(second);
  expect(title.className).toBe('h1');
});

test('the homepage CSS ships with the page and its motion stays within the rules', () => {
  renderHome();
  // One React-rendered sheet, hoisted to the head, in the / chunk with the page.
  expect(document.head.querySelector('style[data-href="townwise-home"]')?.textContent).toBe(homeCss);
  const rules = homeCss.split('\n').filter((line) => line.trim() !== '');
  expect(rules.filter((line) => !line.includes('.pg-home') && !line.startsWith('@keyframes'))).toEqual([]);
  // Step 03's live phase is the one sequence of moments: six moves 650ms apart from 1s, each a 400ms moment,
  // its timing pinned by how.test.web.tsx. Its two rules are left out here, and each move is held to the same 600ms.
  const live = /\.pg-home \.hv\.is-on \.v3-(?:flow|new)\{animation:[^}]*\}/g;
  expect(homeCss.match(live)).toHaveLength(2);
  expect(FLOW.move).toBeLessThanOrEqual(600);
  const durations = rules.flatMap((line) => [...line.replace(live, '').matchAll(/(\d+)ms/g)].map((match) => Number(match[1])));
  expect(durations.length).toBeGreaterThan(0);
  // One-time moments (the title, the section reveals) stay under 900ms; hover and press stay under 300ms.
  expect(Math.max(...durations)).toBeLessThanOrEqual(600);
  expect(homeCss).toContain('transition:border-color 150ms ease,transform 160ms var(--eo)}');
  for (const line of rules) {
    expect(line).not.toMatch(/transition:\s*all|ease-in(?!-out)|scale\(0\)/);
    expect(line).not.toMatch(/(?:transition|animation)[^;}]*(?:width|height|top|left|margin|padding)\b/);
  }
});
