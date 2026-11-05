import { act, cleanup, render } from '@testing-library/react';

import { FLOW, FLOW_DAY_PX, homeCss } from '../../src/marketing/homeStyles.web';
import { HowItWorks } from '../../src/marketing/HowItWorks.web';
import { ScrollRoot } from '../../src/marketing/MarketingShell.web';

const BAND = '-45% 0px -45% 0px';
const VISUAL_VIEW = { threshold: 0.5, rootMargin: '0px' };
const TITLES = ['Research the town', 'Build the forecast', 'Calibrate with your sales', 'Turn the forecast into orders'];

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

  // Reports the given targets only, as a scroll that moves them across a margin does.
  report(changes: readonly [Element, boolean, number][]): void {
    const entries = changes.map(([target, isIntersecting, intersectionRatio]) => ({ target, isIntersecting, intersectionRatio }) as IntersectionObserverEntry);
    act(() => { this.callback(entries, this as unknown as IntersectionObserver); });
  }
}

function installObserver(): void {
  Object.defineProperty(window, 'IntersectionObserver', { configurable: true, writable: true, value: FakeObserver });
}

function media(state: { wide: boolean; reduce: boolean }): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: (state.wide && query === '(min-width: 1024px)') || (state.reduce && query === '(prefers-reduced-motion: reduce)'),
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

// The section's steps inside the page's scroll container, which is the observers' root.
function renderHow(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  render(<ScrollRoot value={{ current: root }}><HowItWorks /></ScrollRoot>, { container: root });
  return root;
}

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

function steps(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.steps > li')];
}

function stageOf(root: HTMLElement): HTMLElement {
  const stage = root.querySelector<HTMLElement>('.hw-st');
  if (stage === null) throw new Error('no stage');
  return stage;
}

function observerOf(target: Element): FakeObserver {
  const found = FakeObserver.instances.find((observer) => observer.observed.includes(target));
  if (found === undefined) throw new Error('no observer for the target');
  return found;
}

// What the pinned layout shows: the active step's title, the current number and the stage's visual on.
function shown(root: HTMLElement): { active: string[]; current: string[]; on: number[] } {
  return {
    active: [...root.querySelectorAll('.hw-s.is-act h3')].map((title) => title.textContent),
    current: [...root.querySelectorAll('.hw-pg li.is-cur')].map((item) => item.textContent),
    on: [...root.querySelectorAll('.hw-vz > .hv')].flatMap((visual, index) => (visual.classList.contains('is-on') ? [index] : [])),
  };
}

test('from 1024px the step in the center band is the active one, and only one step is active at a time', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const root = renderHow();
  const slots = steps(root);
  expect(slots.map((step) => step.querySelector('h3')?.textContent)).toEqual(TITLES);
  expect(root.querySelector('.hw')?.className).toBe('hw is-pin');
  // The visuals live in the stage only.
  expect(root.querySelectorAll('.hv-in')).toHaveLength(0);

  const band = observerOf(at(slots, 0));
  expect(band.observed).toEqual(slots);
  expect(band.options).toEqual({ root, threshold: 0, rootMargin: BAND });
  // Step 01 to start; the stage plays nothing until half of it has been in view.
  expect(shown(root)).toEqual({ active: ['Research the town'], current: ['01'], on: [] });
  const stage = stageOf(root);
  const seen = observerOf(stage);
  expect(seen.options).toEqual({ root, ...VISUAL_VIEW });
  seen.report([[stage, true, 0.3]]);
  expect(shown(root).on).toEqual([]);
  seen.report([[stage, true, 0.5]]);
  expect(shown(root)).toEqual({ active: ['Research the town'], current: ['01'], on: [0] });

  band.report([[at(slots, 0), false, 0], [at(slots, 1), true, 0.2]]);
  expect(shown(root)).toEqual({ active: ['Build the forecast'], current: ['02'], on: [1] });
  // Two steps in the band at once: nothing changes until exactly one is.
  band.report([[at(slots, 2), true, 0.01]]);
  expect(shown(root)).toEqual({ active: ['Build the forecast'], current: ['02'], on: [1] });
  band.report([[at(slots, 1), false, 0]]);
  expect(shown(root)).toEqual({ active: ['Calibrate with your sales'], current: ['03'], on: [2] });
  // Back up: step 02 enters the band while 03 is still in it, so 03 stays until 02 is alone there.
  band.report([[at(slots, 1), true, 0.01]]);
  expect(shown(root)).toEqual({ active: ['Calibrate with your sales'], current: ['03'], on: [2] });
  band.report([[at(slots, 2), false, 0]]);
  expect(shown(root)).toEqual({ active: ['Build the forecast'], current: ['02'], on: [1] });
  // With no step in the band, the last one stays.
  band.report([[at(slots, 1), false, 0]]);
  expect(shown(root)).toEqual({ active: ['Build the forecast'], current: ['02'], on: [1] });
  band.report([[at(slots, 0), true, 0.2]]);
  expect(shown(root)).toEqual({ active: ['Research the town'], current: ['01'], on: [0] });
});

test('the stage is decorative: aria-hidden, nothing focusable, illustrations only, pinned in px', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const root = renderHow();
  const container = root.querySelector('.hw-stc');
  expect(container?.getAttribute('aria-hidden')).toBe('true');
  expect(container?.contains(stageOf(root))).toBe(true);
  expect(container?.querySelectorAll('a, button, input, select, textarea, [href], [tabindex], [contenteditable]')).toHaveLength(0);
  const charts = [...(container?.querySelectorAll('svg') ?? [])];
  expect(charts).toHaveLength(2);
  for (const chart of charts) expect(chart.getAttribute('focusable')).toBe('false');
  // The step text carries the meaning and stays exposed.
  for (const step of steps(root)) expect(step.closest('[aria-hidden="true"]')).toBeNull();

  const visuals = [...stageOf(root).querySelectorAll<HTMLElement>('.hw-vz > .hv')];
  expect(visuals.map((visual) => visual.querySelector('.hv-cap')?.textContent)).toEqual([
    'Hanover, NH. Dates from public calendars.', 'Illustration, not real output', 'Illustration, not real output', 'Planned. Illustration.',
  ]);
  // 01: the real Hanover dates, staggered; 02 and 03: no axis numbers; 04: placeholders only.
  const dates = [...at(visuals, 0).querySelectorAll<HTMLElement>('.v1-l li')];
  expect(dates.map((date) => date.textContent)).toEqual(['Sep 202614Fall term classes begin', 'Nov 202617Fall term classes end', 'Jan 20275Winter term classes begin']);
  expect(dates.map((date) => date.style.getPropertyValue('--n'))).toEqual(['0', '1', '2']);
  expect([...at(visuals, 1).querySelectorAll('.v2-tags li')].map((tag) => tag.textContent)).toEqual([
    'quantile regression', 'event model', 'gradient-boosted trees', 'rolling backtest',
  ]);
  expect(at(visuals, 1).querySelector('.v2-line')?.getAttribute('pathLength')).toBe('1');
  expect(container?.querySelectorAll('svg text')).toHaveLength(0);
  expect([...at(visuals, 3).querySelectorAll('.v4-r')].map((row) => row.textContent)).toEqual(Array<string>(3).fill('{item}order{quantity}by{weekday}{reason}'));

  // Sticky and centered in the scroll container (a sticky top's percentage is of its height), at least 16px from
  // the top, 520px tall; each step a 560px slot, centered in it, so the active step sits beside the stage; no
  // viewport units, no snapping.
  expect(homeCss).toContain('.pg-home .hw-st{position:sticky;top:max(16px,calc(50% - 260px));height:520px;');
  expect(homeCss).toContain('.pg-home .hw.is-pin .hw-s{min-height:560px;align-content:center}');
  expect(homeCss).not.toMatch(/\d(?:vh|svh|dvh|lvh)\b|scroll-snap/);
});

test('under 1024px each step shows its own visual under its text, playing once as half of it comes into view', () => {
  installObserver();
  media({ wide: false, reduce: false });
  const root = renderHow();
  expect(root.querySelector('.hw')?.className).toBe('hw');
  expect(root.querySelector('.hw-stc')).toBeNull();
  expect(FakeObserver.instances.filter((observer) => observer.options?.rootMargin === BAND)).toEqual([]);
  expect(root.querySelectorAll('.is-act')).toHaveLength(0);

  const visuals = steps(root).map((step) => {
    const visual = step.querySelector<HTMLElement>(':scope > .hv-in');
    if (visual === null) throw new Error('no inline visual');
    return visual;
  });
  for (const visual of visuals) {
    expect(visual.className).toBe('hv hv-in');
    expect(visual.getAttribute('aria-hidden')).toBe('true');
  }
  const third = at(visuals, 2);
  const watcher = observerOf(third);
  expect(watcher.observed).toEqual([third]);
  expect(watcher.options).toEqual({ root, ...VISUAL_VIEW });
  watcher.report([[third, true, 0.2]]);
  expect(third.className).toBe('hv hv-in');
  watcher.report([[third, true, 0.5]]);
  expect(visuals.map((visual) => visual.className)).toEqual(['hv hv-in', 'hv hv-in', 'hv hv-in is-on', 'hv hv-in']);
  expect(watcher.disconnected).toBe(true);
});

test('with reduced motion the stage swaps its visuals with fades only, without transforms', () => {
  installObserver();
  media({ wide: true, reduce: true });
  const root = renderHow();
  const stage = stageOf(root);
  observerOf(stage).report([[stage, true, 0.6]]);
  expect(shown(root).on).toEqual([0]);
  const slots = steps(root);
  observerOf(at(slots, 0)).report([[at(slots, 0), false, 0], [at(slots, 3), true, 0.2]]);
  expect(shown(root)).toEqual({ active: ['Turn the forecast into orders'], current: ['04'], on: [3] });
  for (const element of root.querySelectorAll('[style]')) expect(element.getAttribute('style')).not.toMatch(/transform|translate|scale|clip-path/);

  // The swap is a fade: the outgoing visual out in 120ms, the incoming in.
  expect(homeCss).toContain('.pg-home .hv{display:grid;gap:16px;align-content:center;opacity:0;transition:opacity 120ms ease}');
  expect(homeCss).toContain('.pg-home .hv.is-on{opacity:1;transition:opacity 150ms var(--eo)}');
  // Every movement in How it works sits under no-preference, so reduced motion keeps only the fades, with the
  // lines fully drawn and in place.
  const how = homeCss.split('\n').filter((line) => /\.(?:hw|hv|v[1-4]-|step)/.test(line));
  const moving = how.filter((line) => /(?<!text-)transform|translate|scale\(|clip-path|stroke-dash/.test(line));
  expect(moving).toEqual([expect.stringMatching(/^@media \(prefers-reduced-motion:no-preference\)\{/)]);
  const motion = at(moving, 0);
  expect(motion).toContain('.pg-home .v1-l li{transform:translateY(-12px);');
  expect(motion).toContain('.pg-home .hv.is-on .v2-line{stroke-dashoffset:0;transition:stroke-dashoffset 500ms var(--eo) 100ms}');
  expect(motion).toContain('.pg-home .hv.is-on .v3-line{transform:none;transition:transform 400ms var(--eio) 500ms}');
  expect(motion).toContain('.pg-home .hv.is-on .v4-r{clip-path:inset(0 0 0 0);transition:clip-path 280ms var(--eo) calc(100ms + var(--n) * 60ms)}');
  expect(homeCss).toContain('.pg-home{--eio:cubic-bezier(0.77,0,0.175,1)}');
});

test('without IntersectionObserver the steps stack, each with its visual shown as it is', () => {
  media({ wide: true, reduce: false });
  const root = renderHow();
  expect(root.querySelector('.hw')?.className).toBe('hw');
  expect(root.querySelector('.hw-stc')).toBeNull();
  expect(root.querySelectorAll('.is-act')).toHaveLength(0);
  expect(steps(root).map((step) => step.querySelector(':scope > .hv-in')?.className)).toEqual(Array<string>(4).fill('hv hv-in is-on'));
});

test('each illustration enters within 900ms on the entering curves, its parts 30 to 80ms apart', () => {
  // Each part's last instance: the third date, the fourth tag, the eleventh dot (history to today), the third row.
  const last = { 'v1-l li': 2, 'v2-band': 0, 'v2-line': 0, 'v2-tags li': 3, 'v3-dot': 10, 'v3-line': 0, 'v3-fc': 0, 'v3-today': 0, 'v4-r': 2 };
  for (const [part, n] of Object.entries(last)) {
    const rules = [...homeCss.matchAll(new RegExp(`\\.hv\\.is-on \\.${part}\\{([^}]*)\\}`, 'g'))].map((match) => match[1] ?? '');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const timings = [...rule.matchAll(/(\d+)ms var\(--(eo|eio)\) (?:(\d+)ms|calc\((\d+)ms \+ var\(--n\) \* (\d+)ms\))/g)];
      expect(timings.length).toBeGreaterThan(0);
      for (const [, duration, , delay, start, step] of timings) {
        if (step !== undefined) {
          expect(Number(step)).toBeGreaterThanOrEqual(30);
          expect(Number(step)).toBeLessThanOrEqual(80);
        }
        expect(Number(duration) + Number(delay ?? Number(start) + n * Number(step))).toBeLessThanOrEqual(900);
      }
    }
  }
});

test('after the fit, step 03 moves on 12 days in six moves, once and under 5 seconds, each new actual landing at today', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const root = renderHow();
  const live = at([...stageOf(root).querySelectorAll<HTMLElement>('.hw-vz > .hv')], 2);
  expect([...live.querySelectorAll('.v3-lg li')].map((item) => item.textContent)).toEqual(['Actual', 'Predicted', 'Forecast', 'Today']);
  expect(live.querySelectorAll('svg text')).toHaveLength(0);

  // The live phase starts after the 900ms enter, moves for under 5 seconds (WCAG 2.2.2) and runs once.
  expect(FLOW.start).toBeGreaterThanOrEqual(900);
  expect(FLOW.every * FLOW.steps).toBeLessThan(5000);
  expect(FLOW.move).toBeLessThan(FLOW.every);
  const motion = homeCss.split('\n').find((line) => line.startsWith('@media (prefers-reduced-motion:no-preference){.pg-home .v1-l li')) ?? '';
  expect(motion).toContain(`.pg-home .hv.is-on .v3-flow{animation:twFlow ${String(FLOW.every * FLOW.steps)}ms var(--eio) ${String(FLOW.start)}ms both}`);
  expect(motion).toContain(`.pg-home .hv.is-on .v3-new{animation:twLand 240ms var(--eo) calc(${String(FLOW.start + FLOW.move)}ms + var(--k) * ${String(FLOW.every)}ms) both}`);
  // Only the no-preference rules animate it, so reduced motion shows the fitted chart standing still.
  expect(homeCss.split('\n').filter((line) => /v3-(?:flow|new)\{[^}]*animation/.test(line))).toEqual([motion]);
  expect(homeCss).not.toMatch(/infinite/);
  const flow = /@keyframes twFlow\{(.*)\}\n/.exec(homeCss)?.[1] ?? '';
  const shifts = [...flow.matchAll(/translateX\((-[\d.]+)px\)/g)].map((match) => Number(match[1]));
  expect(Math.min(...shifts)).toBeCloseTo(-FLOW.steps * FLOW.daysPerStep * FLOW_DAY_PX, 1);

  // Three moving groups (solid past, dashed forecast, dots) under clips that stay put; the dashed forecast is the
  // same model line as the solid past, and the two clips meet at today.
  const today = Number(live.querySelector('.v3-today')?.getAttribute('x1'));
  expect(live.querySelectorAll('.v3-flow')).toHaveLength(3);
  for (const group of live.querySelectorAll('.v3-flow')) expect(group.parentElement?.closest('.v3-flow')).toBeNull();
  expect(live.querySelector('.v3-fc')?.getAttribute('d')).toBe(live.querySelector('.v3-line')?.getAttribute('d'));
  const [view, past, ahead] = [...live.querySelectorAll('clipPath rect')].map((rect) => ['x', 'width'].map((name) => Number(rect.getAttribute(name))));
  expect(past).toEqual([0, expect.closeTo(today, 1) as number]);
  expect(at(ahead ?? [], 0)).toBeCloseTo(today, 1);
  expect(view).toEqual([8, 384]);

  // History to today, then one new actual per move, each reaching the today line when its move ends.
  expect(live.querySelectorAll('.v3-dot')).toHaveLength(11);
  expect(Number(at([...live.querySelectorAll('.v3-dot')], 10).getAttribute('cx'))).toBeCloseTo(today, 1);
  const landing = [...live.querySelectorAll<SVGCircleElement>('.v3-new')];
  expect(landing).toHaveLength(FLOW.steps);
  landing.forEach((dot, k) => {
    expect(dot.style.getPropertyValue('--k')).toBe(String(k));
    expect(Number(dot.getAttribute('cx')) - (k + 1) * FLOW.daysPerStep * FLOW_DAY_PX).toBeCloseTo(today, 0);
  });
});
