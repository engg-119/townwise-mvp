import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { ScrollRoot } from '../../src/marketing/MarketingShell.web';
import { MONTHS } from '../../src/marketing/map/countyData';
import { mapTowns, markerScale, MONTH_NAMES } from '../../src/marketing/map/mapState';
import { NortheastMap } from '../../src/marketing/map/NortheastMap.web';
import { cursorX, finale, flowOf, moveAt, moveSentence, placeTags, railFill, titleBox } from '../../src/marketing/map/story';
import { storyCss } from '../../src/marketing/map/storyStyles.web';

const BAND = { top: 405, bottom: 495, left: 0, right: 1280, width: 1280, height: 90 };

interface Rect { top: number; bottom: number }

// jsdom has no IntersectionObserver, ResizeObserver, matchMedia or layout, so each test installs what it needs.
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

  // Reports the given targets only, as a scroll that moves them across the band's edges does.
  report(changes: readonly { target: Element; inBand: boolean; rect: Rect; rootBounds?: typeof BAND | null }[]): void {
    const entries = changes.map(({ target, inBand, rect, rootBounds }) => ({
      target,
      isIntersecting: inBand,
      intersectionRatio: inBand ? 0.5 : 0,
      rootBounds: rootBounds === undefined ? BAND : rootBounds,
      boundingClientRect: { ...rect, left: 0, right: 500, width: rect.bottom - rect.top === 0 ? 0 : 500, height: rect.bottom - rect.top },
    })) as unknown as IntersectionObserverEntry[];
    act(() => { this.callback(entries, this as unknown as IntersectionObserver); });
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void { this.observed.push(target); }
  unobserve(): void { return undefined; }
  disconnect(): void { this.disconnected = true; }

  resize(): void {
    act(() => { this.callback([], this); });
  }

  // A change in the size of `target`, which the browser reports only for an observed element (and for each one
  // as its observation starts).
  resizeOf(target: Element): void {
    if (this.observed.includes(target)) this.resize();
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

// A layout for jsdom: sizes by class name, read when the story measures itself.
const layout: { width: Record<string, number>; height: Record<string, number> } = { width: {}, height: {} };

function sizeOf(element: Element, sizes: Record<string, number>): number {
  for (const [name, size] of Object.entries(sizes)) if (element.classList.contains(name)) return size;
  return 0;
}

beforeEach(() => {
  // "Today" is Thu, Nov 5, 2026, so a picked town opens on November.
  jest.useFakeTimers({ now: new Date(2026, 10, 5, 12, 0, 0) });
  layout.width = {};
  layout.height = {};
  jest.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function width(this: Element) { return sizeOf(this, layout.width); });
  jest.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function height(this: Element) { return sizeOf(this, layout.height); });
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function height(this: HTMLElement) { return sizeOf(this, layout.height); });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  FakeObserver.instances = [];
  FakeResizeObserver.instances = [];
  Reflect.deleteProperty(window, 'IntersectionObserver');
  Reflect.deleteProperty(window, 'ResizeObserver');
  Reflect.deleteProperty(window, 'matchMedia');
});

// The map inside the page's scroll container, which is every observer's root.
function renderStory(head?: React.ReactNode): { root: HTMLElement; frame: HTMLElement; story: HTMLElement; unmount: () => void } {
  const root = document.createElement('div');
  root.className = 'tw';
  document.body.append(root);
  const view = render(<ScrollRoot value={{ current: root }}><NortheastMap head={head} /></ScrollRoot>, { container: root });
  const frame = root.querySelector<HTMLElement>('.app-a');
  const story = root.querySelector<HTMLElement>('.story');
  if (frame === null || story === null) throw new Error('no story');
  return { root, frame, story, unmount: view.unmount };
}

// The page's scroll container as MarketingShell renders it, a parent of the map: its ref attaches only after the
// map's layout effects have run.
function Shell(props: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} className="tw"><ScrollRoot value={ref}>{props.children}</ScrollRoot></div>;
}

function renderInShell(): { root: HTMLElement; story: HTMLElement; resize: FakeResizeObserver } {
  const view = render(<Shell><NortheastMap /></Shell>);
  const root = view.container.querySelector<HTMLElement>('.tw');
  const story = view.container.querySelector<HTMLElement>('.story');
  const [resize] = FakeResizeObserver.instances;
  if (root === null || story === null || resize === undefined) throw new Error('no story');
  // The observer reports each element as its observation starts; a frame later the map is measured.
  resize.resizeOf(story);
  act(() => { jest.advanceTimersByTime(20); });
  return { root, story, resize };
}

function slots(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.st-s')];
}

function slot(index: number): HTMLElement {
  const found = slots()[index];
  if (found === undefined) throw new Error(`no slot ${String(index)}`);
  return found;
}

function band(): FakeObserver {
  const found = FakeObserver.instances.find((observer) => observer.observed.includes(slot(0)) && !observer.disconnected);
  if (found === undefined) throw new Error('no band observer');
  return found;
}

function intro(): FakeObserver {
  const box = document.querySelector('.map-box');
  const found = FakeObserver.instances.find((observer) => box !== null && observer.observed.includes(box));
  if (found === undefined) throw new Error('no intro observer');
  return found;
}

// Where slot `index` sits when slot `at` is in the band: above it, in it or below it.
function rectFor(index: number, at: number): Rect {
  if (index === at) return { top: 400, bottom: 500 };
  return index < at ? { top: -800 + index * 10, bottom: -700 + index * 10 } : { top: 900 + index * 10, bottom: 1000 + index * 10 };
}

// A scroll that brings slot `at` into the band, as the first report does: every slot reports.
function step(at: number): void {
  band().report(slots().map((target, index) => ({ target, inBand: index === at, rect: rectFor(index, at) })));
}

// The layout every slot has now, for the story to read when no slot is in the band.
function place(rects: (index: number) => Rect): void {
  slots().forEach((target, index) => {
    const rect = rects(index);
    target.getBoundingClientRect = () => ({ ...rect, left: 0, right: 500, width: 500, height: rect.bottom - rect.top, x: 0, y: rect.top, toJSON: () => rect });
  });
}

function listHeader(): string | null | undefined {
  return document.querySelector('.list-m')?.textContent;
}

function row(label: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: new RegExp(`^${label}`) });
}

// The map's own Back, in the zoom bar (the card has one too).
function mapBack(): HTMLElement {
  const [back] = screen.getAllByRole('button', { name: 'Back to the Northeast' });
  if (back === undefined) throw new Error('no Back');
  return back;
}

function nantucketScale(): number {
  const marker = [...document.querySelectorAll<HTMLElement>('.mk-pos')].find((element) => element.querySelector('.mtag')?.textContent === 'Nantucket, MA');
  return Number(marker?.style.getPropertyValue('--k'));
}

const NANTUCKET = mapTowns.find((town) => town.id === 'nantucket-ma')?.series.gap ?? [];

test('the story starts at its title, with one band observer on the scroll container over the sixteen slots', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { root, frame, story } = renderStory();
  expect(story.className).toBe('story is-on ss-0');
  expect(frame.className).toBe('app app-a is-region is-pre');
  expect(slots().map((element) => element.dataset.ss)).toEqual([...Array(16).keys()].map(String));
  expect(band().options).toEqual({ root, threshold: 0, rootMargin: '-45% 0px -45% 0px' });
  // The slots in step order, then the story itself.
  expect(band().observed).toEqual([...slots(), story]);
  expect(intro().options).toEqual({ root, threshold: 0.4 });
  // The panel and the strip repeat what the steps and the list say; they are hidden from assistive tech.
  expect(document.querySelector('.st-tl')?.getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelector('.pin-tl')?.getAttribute('aria-hidden')).toBe('true');
  for (const element of slots()) expect(element.closest('[aria-hidden="true"]')).toBeNull();
});

test('exactly one slot in the band sets the step: the region, the towns, then each month, then back to the reader’s month', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { frame, story } = renderStory();
  step(1);
  expect(story.className).toBe('story is-on ss-1');
  expect(frame.className).toContain('is-region');
  // The band straddles slots 1 and 2: nothing changes until exactly one is in it.
  band().report([{ target: slot(2), inBand: true, rect: { top: 480, bottom: 1040 } }]);
  expect(story.className).toBe('story is-on ss-1');
  band().report([{ target: slot(1), inBand: false, rect: { top: -100, bottom: 400 } }]);
  expect(story.className).toBe('story is-on ss-2');
  expect(frame.className).toContain('is-local');
  expect(listHeader()).toBe('Gap in Jan 2024');

  step(3);
  expect(story.className).toBe('story is-on ss-3 is-months');
  expect(document.querySelector('.tl-m')?.textContent).toBe('Jan');
  expect(document.querySelector('.tl-y')?.textContent).toBe('2024');
  expect(document.querySelector('.tl-line')?.textContent).toBe('January starts the 2024 data, so there is no month before it to compare.');
  expect(document.querySelector('.ptl-m')?.textContent).toBe('Jan 2024');

  const ticks: string[] = [];
  for (let month = 1; month < 12; month += 1) {
    step(month + 3);
    expect(story.className).toBe(`story is-on ss-${String(month + 3)} is-months`);
    expect(document.querySelector('.tl-m')?.textContent).toBe(MONTHS[month]);
    expect(document.querySelector('.tl-line')?.textContent).toBe(moveSentence(month));
    expect(document.querySelector('.ptl-m')?.textContent).toBe(`${MONTHS[month] ?? ''} 2024`);
    expect([...document.querySelectorAll('.tl-rail li')].map((item) => item.className)).toEqual(MONTHS.map((_, index) => (index < month ? 'is-p' : index === month ? 'is-c' : '')));
    expect(document.querySelector<HTMLElement>('.tl-fill')?.style.transform).toBe(`scaleY(${railFill(month).toFixed(4)})`);
    expect(document.querySelector<HTMLElement>('.tl-cur')?.style.transform).toBe(`translateX(${String(cursorX(month))}px)`);
    expect(nantucketScale()).toBeCloseTo(markerScale(NANTUCKET[month] ?? 0), 3);
    expect(listHeader()).toBe(`Gap in ${MONTHS[month] ?? ''} 2024`);
    ticks.push(document.querySelector('.tl-m')?.className ?? '');
  }
  // Each month ticks in: the class flips between two copies so the animation replays.
  expect(new Set(ticks)).toEqual(new Set(['tl-m tl-a', 'tl-m tl-b']));
  expect(frame.className).toContain('is-sm');

  step(15);
  expect(story.className).toBe('story is-on ss-15');
  // The last step rests on the reader's month: today is Nov 5, 2026, so November 2024 in the data.
  expect(listHeader()).toBe('Gap in Nov 2024');
  expect(nantucketScale()).toBeCloseTo(markerScale(NANTUCKET[10] ?? 0), 3);
  expect(screen.getByRole('heading', { level: 2, name: 'November, this month in 2024.' })).toBeTruthy();
  expect(screen.getByText(finale(10).line)).toBeTruthy();
});

test('scrolling back up runs the story backward to the region', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { frame, story } = renderStory();
  step(15);
  step(14);
  expect(listHeader()).toBe('Gap in Dec 2024');
  step(5);
  expect(story.className).toBe('story is-on ss-5 is-months');
  expect(listHeader()).toBe('Gap in Mar 2024');
  step(1);
  expect(story.className).toBe('story is-on ss-1');
  expect(frame.className).toContain('is-region');
});

test('a jump past the story ends it at the last step, and a jump back returns it to the title', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { root, frame, story } = renderStory();
  step(5);
  // Tab to the lead's action: the page jumps past the story. Only slot 5 leaves the band, so only it reports;
  // the slots it skipped still have their old sides, and the layout says every slot is now above the band.
  place((index) => ({ top: -6000 + index * 300, bottom: -5700 + index * 300 }));
  band().report([{ target: slot(5), inBand: false, rect: { top: -4500, bottom: -4300 } }]);
  expect(story.className).toBe('story is-on ss-15');
  expect(listHeader()).toBe('Gap in Nov 2024');

  // Home: back to the top, where the title's slot is in the band.
  place((index) => rectFor(index, 0));
  band().report([{ target: slot(0), inBand: true, rect: rectFor(0, 0) }]);
  expect(story.className).toBe('story is-on ss-0');
  expect(frame.className).toContain('is-region');

  // On a phone the pinned map's flow sits between the title and the first card, so a jump from past the story to
  // the top moves no slot across the band: only the story reports. Without root bounds the band comes from the
  // scroll container's own box.
  step(9);
  place((index) => ({ top: -6000 + index * 300, bottom: -5700 + index * 300 }));
  band().report([{ target: slot(9), inBand: false, rect: { top: -3300, bottom: -3100 } }]);
  expect(story.className).toBe('story is-on ss-15');
  layout.height = { tw: 844 };
  root.getBoundingClientRect = () => ({ top: 0, bottom: 844, left: 0, right: 390, width: 390, height: 844, x: 0, y: 0, toJSON: () => null });
  place((index) => (index === 0 ? { top: 65, bottom: 433 } : { top: 853 + index * 500, bottom: 1353 + index * 500 }));
  band().report([{ target: story, inBand: true, rect: { top: 65, bottom: 9000 }, rootBounds: null }]);
  expect(story.className).toBe('story is-on ss-0');
});

test('a hidden screen (zero rects) holds the step', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { story } = renderStory();
  step(6);
  // The stack hides the page with display: none: every slot reports out of the band with no box.
  place(() => ({ top: 0, bottom: 0 }));
  band().report(slots().map((target) => ({ target, inBand: false, rect: { top: 0, bottom: 0 }, rootBounds: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } })));
  expect(story.className).toBe('story is-on ss-6 is-months');
  expect(listHeader()).toBe('Gap in Apr 2024');
});

test('the pinned map is sized in px from the scroll container before the first paint, and on phones the band sits below the pin', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: true, reduce: false });
  layout.width = { story: 1280 };
  layout.height = { tw: 900 };
  const { root, story } = renderStory();
  expect(story.style.getPropertyValue('--story-mw')).toBe('732px');
  expect(story.style.getPropertyValue('--story-mh')).toBe('637px');
  expect(story.style.getPropertyValue('--story-top')).toBe('57px');
  expect(story.style.getPropertyValue('--story-ex')).toBe('150px');
  const [resize] = FakeResizeObserver.instances;
  if (resize === undefined) throw new Error('no resize observer');
  expect(resize.observed).toEqual([story, document.querySelector('.map-fig'), document.querySelector('.pin-cap'), root]);

  // The legend and caption measure 176px, more than the 150px budget: the map shrinks so the block still fits,
  // centered, a frame after the resize.
  layout.height = { tw: 900, 'map-fig': 148, 'pin-cap': 28 };
  resize.resize();
  expect(story.style.getPropertyValue('--story-ex')).toBe('150px');
  act(() => { jest.advanceTimersByTime(20); });
  expect(story.style.getPropertyValue('--story-ex')).toBe('176px');
  expect(story.style.getPropertyValue('--story-mw')).toBe('702px');
  expect(story.style.getPropertyValue('--story-mh')).toBe('611px');
  expect(story.style.getPropertyValue('--story-top')).toBe('57px');
  expect(band().options?.rootMargin).toBe('-45% 0px -45% 0px');

  // A hidden screen measures 0 and changes nothing.
  layout.width = {};
  resize.resize();
  act(() => { jest.advanceTimersByTime(20); });
  expect(story.style.getPropertyValue('--story-mw')).toBe('702px');
});

test('on a phone the band is the middle tenth of the window below the pinned map', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: false, reduce: false });
  layout.width = { story: 358 };
  layout.height = { tw: 844, 'story-pin': 420 };
  const { root, story } = renderStory();
  expect(story.style.getPropertyValue('--story-mw')).toBe('358px');
  expect(story.style.getPropertyValue('--story-top')).toBe('0px');
  const first = band();
  expect(first.options).toEqual({ root, threshold: 0, rootMargin: '-611px 0px -191px 0px' });
  // Safari's toolbars shrink the window: the map shrinks and the band moves with the pin.
  layout.height = { tw: 664, 'story-pin': 340 };
  const [resize] = FakeResizeObserver.instances;
  resize?.resize();
  act(() => { jest.advanceTimersByTime(20); });
  expect(story.style.getPropertyValue('--story-mw')).toBe('280px');
  expect(first.disconnected).toBe(true);
  expect(band().options?.rootMargin).toBe('-486px 0px -146px 0px');
});

test('the scroll container is watched even though its ref attaches after the map: from 1024px a window that changes only its height moves the map’s top', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: true, reduce: false });
  layout.width = { story: 900 };
  layout.height = { tw: 900 };
  const { root, story, resize } = renderInShell();
  expect(resize.observed.includes(root)).toBe(true);
  expect(story.style.getPropertyValue('--story-mw')).toBe('600px');
  expect(story.style.getPropertyValue('--story-top')).toBe('114px');
  layout.height = { tw: 1000 };
  resize.resizeOf(root);
  act(() => { jest.advanceTimersByTime(20); });
  expect(story.style.getPropertyValue('--story-mw')).toBe('600px');
  expect(story.style.getPropertyValue('--story-top')).toBe('164px');
});

test('on a phone a window that changes only its height moves the band with the pin', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: false, reduce: false });
  layout.width = { story: 358 };
  layout.height = { tw: 844, 'story-pin': 420 };
  const { root, story, resize } = renderInShell();
  expect(band().options).toEqual({ root, threshold: 0, rootMargin: '-611px 0px -191px 0px' });
  // Safari's toolbars shrink the window and nothing else changes size until the map is measured again.
  layout.height = { tw: 664, 'story-pin': 340 };
  resize.resizeOf(root);
  act(() => { jest.advanceTimersByTime(20); });
  expect(story.style.getPropertyValue('--story-mw')).toBe('280px');
  expect(band().options?.rootMargin).toBe('-486px 0px -146px 0px');
});

test('from 1024px the legend is measured again until its height holds, so the map’s block is as tall as the panel’s box', () => {
  installObserver();
  media({ wide: true, reduce: false });
  layout.width = { story: 1138 };
  layout.height = { tw: 650 };
  // The legend wraps onto more lines as the map narrows: 196px down to 248px.
  const wraps: readonly (readonly [number, number])[] = [[500, 196], [460, 212], [440, 228]];
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function height(this: HTMLElement) {
    if (!this.classList.contains('map-fig')) return 0;
    const mw = Number.parseFloat(document.querySelector<HTMLElement>('.story')?.style.getPropertyValue('--story-mw') ?? '0');
    return wraps.find(([narrowest]) => mw > narrowest)?.[1] ?? 248;
  });
  const { story } = renderStory();
  expect(story.style.getPropertyValue('--story-ex')).toBe('248px');
  expect(story.style.getPropertyValue('--story-mw')).toBe('407px');
  expect(story.style.getPropertyValue('--story-mh')).toBe('354px');
  // A short window keeps 24px above and below the block.
  expect(story.style.getPropertyValue('--story-top')).toBe('24px');
});

// Each marker's movers: its value tag, its glyph and its particles.
function movers(): { name: string; tag: string | null; glyph: string | null; flow: string | null; points: string[] }[] {
  return [...document.querySelectorAll<HTMLElement>('.mk-pos')].map((element) => ({
    name: element.querySelector('.mtag')?.textContent ?? '',
    tag: element.querySelector('.vtag')?.textContent ?? null,
    glyph: element.querySelector('.mk-g')?.textContent ?? null,
    flow: element.querySelector('.fl')?.className ?? null,
    points: [...element.querySelectorAll<HTMLElement>('.pt')].map((point) => ['--a', '--d', '--j'].map((name) => point.style.getPropertyValue(name)).join(' ')),
  }));
}

test('from February each step bursts job flows that replay on every step, backward too; picked months and January have none', () => {
  installObserver();
  media({ wide: true, reduce: false });
  renderStory();
  step(3);
  expect(document.querySelectorAll('.pt')).toHaveLength(0);
  step(4);
  expect(document.querySelectorAll('.pt')).toHaveLength(15);
  const february = movers();
  mapTowns.forEach((town, index) => {
    const flow = flowOf(index, moveAt(town.series.gap, 1));
    const shown = february[index];
    expect(shown?.points).toEqual(flow?.points.map((point) => `${String(point.a)}deg ${String(point.d)}px ${String(point.j)}`) ?? []);
    if (flow !== null) expect(shown?.flow).toMatch(new RegExp(`^fl fl-${flow.dir} fl-[ab]$`));
  });
  expect(document.querySelectorAll('.mk-g')).toHaveLength(0);
  const burst = (): string | undefined => document.querySelector('.fl')?.className.split(' ').at(-1);
  const first = burst();
  step(5);
  expect(document.querySelectorAll('.pt')).toHaveLength(18);
  const second = burst();
  expect(second).not.toBe(first);
  // Back up a step: the class flips again, so February's burst plays again.
  step(4);
  expect(burst()).not.toBe(second);
  // A month picked by hand never starts a burst.
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Month' })).getByRole('radio', { name: 'Jun' }), { detail: 1 });
  expect(document.querySelectorAll('.pt')).toHaveLength(0);
});

test('with reduced motion the month still follows the scroll, with a + or − instead of particles and no draw-in', () => {
  installObserver();
  media({ wide: true, reduce: true });
  const { frame } = renderStory();
  expect(frame.className).toBe('app app-a is-region');
  expect(document.querySelector('.m-draw')).toBeNull();
  step(4);
  expect(listHeader()).toBe('Gap in Feb 2024');
  expect(document.querySelectorAll('.pt, .fl')).toHaveLength(0);
  expect(movers().filter((marker) => marker.glyph !== null).map((marker) => [marker.name, marker.glyph])).toEqual([
    ['Amherst, MA', '+'], ['Ithaca, NY', '+'], ['State College, PA', '+'],
  ]);
  step(5);
  expect(movers().filter((marker) => marker.glyph !== null).map((marker) => marker.glyph)).toEqual(['−', '−', '−', '−', '−', '−']);
});

test('the legend and, on phones, step 2 say what the moving dots or the + and − mean; CSS shows the one that applies', () => {
  installObserver();
  renderStory();
  const legend = document.querySelector('.lg-fl');
  expect(legend?.querySelector('.lg-fl-m')?.textContent).toBe('Dots pulling in: restaurant and bar jobs up since last month, compared with the Northeast. Pushing out: down.');
  expect(legend?.querySelector('.lg-fl-r')?.textContent).toBe('+ or − beside a dot: restaurant and bar jobs up or down since last month, compared with the Northeast.');
  const towns = slot(2).querySelector('.st-ph');
  expect(towns?.querySelector('.lg-fl-m')?.textContent).toBe('Month by month, small dots pull in toward a town when its county’s restaurant and bar jobs rose against the Northeast since the month before, and push out when they fell.');
  expect(towns?.querySelector('.lg-fl-r')?.textContent).toBe('Month by month, a + or − beside a dot shows its county’s restaurant and bar jobs up or down against the Northeast since the month before.');
  expect(storyCss).toContain('@media (min-width:1024px){.twmap .st-ph{display:none}}');
  expect(storyCss).toContain('@media (prefers-reduced-motion:reduce){.twmap .fl{display:none}.twmap .mk-g{display:block}.twmap .lg-fl-m{display:none}.twmap .lg-fl-r{display:inline}}');
  expect(storyCss).toContain('.twmap .fl-in.fl-a .pt{animation:twFlInA 700ms var(--eo) calc(var(--j) * 30ms) both}');
});

test('value tags mark the month’s biggest movers inside the pinned map, and clear the title over the flat map', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: true, reduce: false });
  layout.width = { story: 1280 };
  layout.height = { tw: 900 };
  renderStory();
  step(2);
  expect(document.querySelectorAll('.vtag')).toHaveLength(0);
  step(4);
  const expected = [...placeTags(1, 732)].map(([id, tag]) => [mapTowns.find((town) => town.id === id)?.label, tag.text, `vtag vs-${tag.side}`]);
  expect(expected).toHaveLength(3);
  const shown = [...document.querySelectorAll<HTMLElement>('.vtag')].map((tag) => [tag.closest('.mk-pos')?.querySelector('.mtag')?.textContent, tag.textContent, tag.className]);
  expect(shown.sort()).toEqual(expected.sort());
  cleanup();

  // Flat and wide (no observer), the title reaches over the map's northwest corner, which rests on the reader's
  // month (November).
  Reflect.deleteProperty(window, 'IntersectionObserver');
  renderStory();
  const title = titleBox(window.innerWidth, 1280, 732);
  const flat = [...placeTags(10, 732, [title]).values()].map((tag) => tag.text).sort();
  expect([...document.querySelectorAll('.vtag')].map((tag) => tag.textContent).sort()).toEqual(flat);
});

test('a town picked mid-story keeps its zoom while the scroll moves the month, and Back returns to the step', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { frame } = renderStory();
  step(6);
  expect(listHeader()).toBe('Gap in Apr 2024');
  const hanover = row('Hanover, NH');
  fireEvent.click(hanover, { detail: 1 });
  expect(frame.className).toContain('is-zoomed');
  expect(frame.className).not.toContain('is-sm');
  expect(listHeader()).toBe('Gap in Nov 2024');
  step(8);
  expect(listHeader()).toBe('Gap in Jun 2024');
  expect(frame.className).toContain('is-zoomed');
  const focus = jest.spyOn(hanover, 'focus');
  fireEvent.click(mapBack(), { detail: 1 });
  expect(frame.className).not.toContain('is-zoomed');
  expect(frame.className).toContain('is-local');
  expect(listHeader()).toBe('Gap in Jun 2024');
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  // Before the towns, Back returns to the region.
  step(1);
  fireEvent.click(hanover, { detail: 1 });
  expect(frame.className).toContain('is-local');
  fireEvent.click(mapBack(), { detail: 1 });
  expect(frame.className).toContain('is-region');
});

test('the month scrubber sets the month by hand, so the dots jump', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { frame } = renderStory();
  step(5);
  expect(frame.className).toContain('is-sm');
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Month' })).getByRole('radio', { name: 'Oct' }), { detail: 1 });
  expect(listHeader()).toBe('Gap in Oct 2024');
  expect(frame.className).not.toContain('is-sm');
});

test('without an observer the map lies flat at the reader’s month; a silent one lays it flat after a second, and a late report brings the story back', () => {
  media({ wide: true, reduce: false });
  const flat = renderStory();
  expect(flat.story.className).toBe('story is-flat ss-15');
  expect(flat.frame.className).toBe('app app-a is-local');
  expect(listHeader()).toBe('Gap in Nov 2024');
  flat.unmount();
  cleanup();

  installObserver();
  const { story, frame } = renderStory();
  act(() => { jest.advanceTimersByTime(999); });
  expect(story.className).toBe('story is-on ss-0');
  act(() => { jest.advanceTimersByTime(1); });
  expect(story.className).toBe('story is-flat ss-15');
  expect(frame.className).toBe('app app-a is-local');
  // The tab was in the background: the observer reports late, and the story comes back where the band is.
  expect(band().disconnected).toBe(false);
  step(4);
  expect(story.className).toBe('story is-on ss-4 is-months');
  expect(listHeader()).toBe('Gap in Feb 2024');
});

test('from 1024px a zoomed town hides the title, and focus inside it brings back only the part with focus, so the H1 stays off the map’s Back', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const { frame } = renderStory(<div className="hd"><h1>The title</h1><div className="cta-row"><a href="/early-access">Request early access</a></div></div>);
  const head = document.querySelector<HTMLElement>('.st-h .hd');
  const title = head?.querySelector('h1');
  const actions = head?.querySelector('.cta-row');
  if (head == null || title == null || actions == null) throw new Error('no title');
  const hidden = '.twmap .app.is-zoomed .st-h .hd';
  const shown = `${hidden}:focus-within`;
  const rest = `${shown}>:not(:focus-within)`;
  const part = `${hidden}>:focus-within`;
  // The rules that show it come after the one that hides it, in the same block, and are more specific. Its parts
  // are hidden with opacity, so they stay focusable and in the reading order, and a part that loses focus comes
  // back only once the title's 150ms fade has ended.
  const wide = storyCss.slice(storyCss.indexOf('@media (min-width:1024px){\n'));
  const end = wide.indexOf('\n}\n');
  const hide = wide.indexOf(`${hidden}{opacity:0;pointer-events:none}`);
  expect(hide).toBeGreaterThan(-1);
  for (const rule of [`${hidden}>*{transition:opacity 0s 150ms}`, `${shown}{opacity:1}`, `${rest}{opacity:0;transition:none}`, `${part}{pointer-events:auto}`]) {
    expect(wide.indexOf(rule)).toBeGreaterThan(hide);
    expect(wide.indexOf(rule)).toBeLessThan(end);
  }
  expect(head.matches(hidden)).toBe(false);
  fireEvent.click(row('Hanover, NH'), { detail: 1 });
  expect(frame.className).toContain('is-zoomed');
  expect(head.matches(hidden)).toBe(true);
  expect(head.matches(shown)).toBe(false);
  // Tab from the header lands on the title's first link: its actions come back, the H1 stays hidden.
  const link = screen.getByRole('link', { name: 'Request early access' });
  act(() => { link.focus(); });
  expect(document.activeElement).toBe(link);
  expect(head.matches(shown)).toBe(true);
  expect([actions.matches(part), actions.matches(rest)]).toEqual([true, false]);
  expect([title.matches(part), title.matches(rest)]).toEqual([false, true]);
  act(() => { link.blur(); });
  expect(head.matches(shown)).toBe(false);
  expect(title.matches(rest)).toBe(false);
});

test('every step is in the reading order, the story adds no control, and nothing listens to the page', () => {
  installObserver();
  media({ wide: true, reduce: false });
  const onDocument = jest.spyOn(document, 'addEventListener');
  const onWindow = jest.spyOn(window, 'addEventListener');
  const scrolls = jest.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrolls });
  const { story } = renderStory();
  for (let at = 0; at < 16; at += 1) step(at);
  for (const at of [15, 3, 0]) step(at);
  // Each month slot carries its month's sentence for screen readers.
  expect(slots().slice(3, 15).map((element) => element.querySelector('.sr-only')?.textContent)).toEqual(
    MONTH_NAMES.map((name, month) => `${name} 2024. ${moveSentence(month)}`),
  );
  const focusable = [...story.querySelectorAll<HTMLElement>('button, a, [tabindex]')].filter((element) => element.tabIndex >= 0);
  expect(focusable.every((element) => element.tagName === 'BUTTON' || element.tagName === 'A')).toBe(true);
  expect(scrolls).not.toHaveBeenCalled();
  const listened = [...onDocument.mock.calls, ...onWindow.mock.calls].map(([type]) => type);
  for (const type of ['scroll', 'wheel', 'touchmove', 'keydown', 'resize']) expect(listened).not.toContain(type);
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

test('unmounting clears every timer and observer', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: true, reduce: false });
  layout.width = { story: 1280 };
  layout.height = { tw: 900 };
  const { unmount } = renderStory();
  const observers = [band(), intro()];
  FakeResizeObserver.instances[0]?.resize();
  unmount();
  expect(jest.getTimerCount()).toBe(0);
  for (const observer of observers) expect(observer.disconnected).toBe(true);
  expect(FakeResizeObserver.instances.every((observer) => observer.disconnected)).toBe(true);
});

test('the story CSS: the panel shares the pinned map’s box, centered, in px; phones pin the map on top; motion stays within the rules', () => {
  installObserver();
  renderStory();
  expect(document.head.querySelector('style[data-href="townwise-story"]')?.textContent).toBe(storyCss);
  // From 1024px the map and the panel stick at the same top for the same rows (1 to 16), the panel's box as tall
  // as the map's block and centered in it: centered in the window, still from January to the last step, and
  // released with the map only after the last step.
  expect(storyCss).toContain('.twmap .story.is-on .story-pin{grid-column:2;grid-row:1 / span 16;position:sticky;top:var(--story-top,16px);align-self:start;min-height:calc(var(--story-mh,600px) + var(--story-ex,150px))}');
  expect(storyCss).toContain('.twmap .story.is-on .st-tl{display:grid;align-content:center;grid-column:1;grid-row:1 / span 16;align-self:start;position:sticky;top:var(--story-top,16px);height:calc(var(--story-mh,600px) + var(--story-ex,150px));pointer-events:none;opacity:0;transition:opacity 200ms var(--eo)}');
  expect(storyCss).toContain('.twmap .story.is-on.is-months .st-tl{opacity:1}');
  expect(storyCss).toContain('.twmap .story.is-on .st-f{min-height:720px}');
  // Flat and wide, the month panel sits under the title's actions with room between them.
  expect(storyCss).toContain('.twmap .story.is-flat .st-tl{display:block;grid-column:1;grid-row:2;align-self:end;padding-top:40px}');
  expect(storyCss).toContain('.twmap .story.is-on .story-pin{position:sticky;top:0;padding-block:8px 16px;background:var(--ground)}');
  // Under 1024px the final card ends its slot (the story's last), so the map releases as the card passes under it.
  const narrow = storyCss.slice(storyCss.indexOf('@media (max-width:1023px){\n'));
  expect(narrow.slice(0, narrow.indexOf('\n}\n'))).toContain('\n.twmap .story.is-on .st-f{align-content:end;min-height:280px}\n');
  expect(storyCss).toContain('@media (prefers-reduced-motion:reduce){.twmap .tl-fill,.twmap .tl-cur,.twmap .app.is-sm .dot{transition:none}.twmap .tl-m.tl-a,.twmap .tl-m.tl-b,.twmap .tl-line.tl-a,.twmap .tl-line.tl-b,.twmap .ptl-m.tl-a,.twmap .ptl-m.tl-b{animation:none}');
  expect(storyCss).not.toMatch(/\d(?:vh|svh|dvh|lvh)\b|scroll-snap/);
  const lines = storyCss.split('\n').filter((line) => line.trim() !== '');
  expect(lines.filter((line) => !line.includes('.twmap') && !line.startsWith('@keyframes') && !/^@media [^{]*\{$/.test(line) && line !== '}')).toEqual([]);
  for (const line of lines) {
    expect(line).not.toMatch(/transition:\s*all|ease-in(?!-out)|scale\(0\)/);
    expect(line).not.toMatch(/(?:transition|animation)[^;}]*(?:width|height|top|left|margin|padding)\b/);
  }
  const transitions = [...storyCss.matchAll(/transition:([^;}]*)/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)].map((ms) => Number(ms[1])));
  expect(transitions.filter((ms) => ms >= 300)).toEqual([360]);
  const animations = [...storyCss.matchAll(/animation:([^;}]*)/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)].map((ms) => Number(ms[1])));
  expect(Math.max(...animations)).toBeLessThanOrEqual(700);
});

test('from 1024px the first screen centers the map under the header, keeping the title clear of the bottom', () => {
  installObserver();
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
  media({ wide: true, reduce: false });
  layout.width = { story: 1280 };
  // 900px tall: the box is 637 + 150 at 57px, so the map's gaps under the 65px header are equal at 99.5px.
  for (const [title, pad] of [[560, '100px'], [780, '31px'], [840, '24px']] as const) {
    layout.height = { tw: 900, hd: title };
    const { story, unmount } = renderStory(<div className="hd">The Northeast has one season.</div>);
    expect(story.style.getPropertyValue('--story-top')).toBe('57px');
    expect(story.style.getPropertyValue('--story-pad')).toBe(pad);
    unmount();
  }
  // The title block is observed too, since the web font changes its height.
  FakeResizeObserver.instances.length = 0;
  layout.height = { tw: 900, hd: 560 };
  const { story } = renderStory(<div className="hd">The Northeast has one season.</div>);
  expect(FakeResizeObserver.instances.at(-1)?.observed).toContain(story.querySelector('.st-h > .hd'));
  expect(storyCss).toMatch(/@media \(min-width:1024px\)\{[^@]*\.twmap \.story\.is-on\{padding-top:var\(--story-pad,24px\)\}/);
});
