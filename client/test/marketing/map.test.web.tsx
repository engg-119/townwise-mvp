import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { cameraFor, cameraTransform, REGION } from '../../src/marketing/map/camera';
import { countySeries } from '../../src/marketing/map/countyData';
import { mapTowns, markerScale, REST_MONTH } from '../../src/marketing/map/mapState';
import { mapCss } from '../../src/marketing/map/mapStyles.web';
import { NortheastMap } from '../../src/marketing/map/NortheastMap.web';
import { storyCss } from '../../src/marketing/map/storyStyles.web';

// jsdom has neither IntersectionObserver nor matchMedia, so each test installs the ones it needs.
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
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

  // The story's band: slot `step` in it, the slots before it above, the rest below.
  reportStep(step: number): void {
    const band = { top: 405, bottom: 495, left: 0, right: 1000, width: 1000, height: 90 };
    const entries = this.observed.map((target, index) => {
      const [top, bottom] = index === step ? [400, 500] : index < step ? [-300, 100] : [900, 1100];
      return { target, isIntersecting: index === step, intersectionRatio: index === step ? 0.5 : 0, rootBounds: band, boundingClientRect: { top, bottom, left: 0, right: 500, width: 500, height: bottom - top } };
    }) as unknown as IntersectionObserverEntry[];
    act(() => { this.callback(entries, this as unknown as IntersectionObserver); });
  }
}

// The observer that watches an element (the map box for the intro, the title's slot for the story's band).
function observerOf(selector: string): FakeObserver {
  const target = document.querySelector(selector);
  const found = FakeObserver.instances.find((observer) => target !== null && observer.observed.includes(target));
  if (found === undefined) throw new Error(`no observer for ${selector}`);
  return found;
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

beforeEach(() => {
  // Every test drives the clock itself, so no intro timer fires unless a test asks for it.
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  FakeObserver.instances = [];
  Reflect.deleteProperty(window, 'IntersectionObserver');
  Reflect.deleteProperty(window, 'matchMedia');
});

function town(id: string): (typeof mapTowns)[number] {
  const found = mapTowns.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no town ${id}`);
  return found;
}

function renderMap(): { mapFrame: HTMLElement; listFrame: HTMLElement; world: SVGGElement } {
  const { container } = render(<NortheastMap />);
  const [mapFrame, listFrame] = container.querySelectorAll<HTMLElement>('.app');
  const world = container.querySelector<SVGGElement>('.world');
  if (mapFrame === undefined || listFrame === undefined || world === null) throw new Error('map not rendered');
  return { mapFrame, listFrame, world };
}

function wait(ms: number): void {
  act(() => { jest.advanceTimersByTime(ms); });
}

function listHeader(): string | null | undefined {
  return document.querySelector('.list-m')?.textContent;
}

function row(label: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: new RegExp(`^${label}`) });
}

function marker(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.mk-pos')].find((element) => element.querySelector('.mtag')?.textContent === label);
  if (found === undefined) throw new Error(`no marker ${label}`);
  return found;
}

function markerButton(label: string): HTMLButtonElement {
  const button = marker(label).querySelector('button');
  if (button === null) throw new Error(`no marker button ${label}`);
  return button;
}

function panel(): HTMLElement {
  const id = row('Hanover, NH').getAttribute('aria-controls')?.split(' ')[0] ?? '';
  const element = document.getElementById(id);
  if (element === null) throw new Error('no panel');
  return element;
}

const NANTUCKET_GAPS = town('nantucket-ma').series.gap;

test('the outlines draw in once the map is in view, and the towns wait for the story', () => {
  installObserver();
  const { mapFrame } = renderMap();
  // Before the map is in view the outlines wait, hidden, and the story starts at its title.
  expect(mapFrame.className).toBe('app app-a is-region is-pre');
  expect(document.querySelector('.story')?.className).toBe('story is-on ss-0');
  const intro = observerOf('.map-box');
  expect(intro.observed).toEqual([document.querySelector('.map-box')]);
  const band = observerOf('.st-h');
  band.reportStep(0);
  intro.report(true, 0.5);
  expect(intro.disconnected).toBe(true);

  wait(450);
  expect(mapFrame.className).toBe('app app-a is-region is-run');
  expect(document.querySelector<SVGPathElement>('.m-draw')?.style.strokeDashoffset).toBe('0');
  wait(900);
  expect(document.querySelector('.m-draw')).toBeNull();
  // The towns appear only when the story reaches them; nothing moves on its own.
  expect(mapFrame.className).toBe('app app-a is-region');
  wait(10_000);
  expect(mapFrame.className).toBe('app app-a is-region');
  expect(band.disconnected).toBe(false);

  band.reportStep(2);
  expect(mapFrame.className).toBe('app app-a is-local is-sm');
  expect(listHeader()).toBe('Gap in Jan 2024');
  // Each marker's scale follows that month's gap, and the scale eases only when the scroll moved the month.
  const nantucket = marker('Nantucket, MA');
  const scale = (): number => Number(nantucket.style.getPropertyValue('--k'));
  expect(scale()).toBeCloseTo(markerScale(NANTUCKET_GAPS[0] ?? 0), 3);
  expect(storyCss).toContain('.twmap .app.is-sm .dot{transition:transform 360ms cubic-bezier(0.34,1.25,0.64,1)}');
  // The markers enter one by one, west to east.
  const order = [...document.querySelectorAll<HTMLElement>('.mk-pos')].map((element) => Number(element.style.getPropertyValue('--i')));
  expect([...order].sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
  expect(mapCss).toContain('calc(var(--dz,0ms) + var(--i) * var(--stg,50ms))');
  band.reportStep(4);
  expect(scale()).toBeCloseTo(markerScale(NANTUCKET_GAPS[1] ?? 0), 3);
  wait(10_000);
  expect(listHeader()).toBe('Gap in Feb 2024');
  // The last step rests on the month with the widest spread of gaps, computed from the data: July 2024.
  band.reportStep(15);
  expect(REST_MONTH).toBe(6);
  expect(listHeader()).toBe('Gap in Jul 2024');
  expect(scale()).toBe(1);
});

test.each([
  ['a town in the list', () => { fireEvent.click(row('Hanover, NH')); }, 'May'],
  ['a marker', () => { fireEvent.click(markerButton('Stowe, VT'), { detail: 1 }); }, 'May'],
  ['the month scrubber', () => { fireEvent.click(screen.getByRole('radio', { name: 'Oct' })); }, 'Oct'],
])('%s sets the month by hand, and nothing changes it on its own', (_name, use, month) => {
  const { mapFrame } = renderMap();
  expect(listHeader()).toBe('Gap in Jul 2024');
  use();
  // A month picked by hand jumps: the dots do not ease.
  expect(mapFrame.className).not.toContain('is-sm');
  expect(listHeader()).toBe(`Gap in ${month} 2024`);
  wait(10_000);
  expect(listHeader()).toBe(`Gap in ${month} 2024`);
});

test('without an observer the map lies flat at the resting month: no draw-in and no playing year', () => {
  const { mapFrame } = renderMap();
  expect(mapFrame.className).toBe('app app-a is-local');
  expect(document.querySelector('.story')?.className).toBe('story is-flat ss-15');
  expect(document.querySelector('.m-draw')).toBeNull();
  expect(screen.queryByRole('button', { name: /the year$/ })).toBeNull();
  wait(20_000);
  expect(listHeader()).toBe('Gap in Jul 2024');
  expect(Number(marker('Nantucket, MA').style.getPropertyValue('--k'))).toBe(1);
});

test('with reduced motion and an observer, the outlines show at once and the story still sets the towns and months', () => {
  installObserver();
  prefersReducedMotion(true);
  const { mapFrame } = renderMap();
  expect(mapFrame.className).toBe('app app-a is-region');
  expect(document.querySelector('.m-draw')).toBeNull();
  observerOf('.map-box').report(true, 0.5);
  expect(mapFrame.className).toBe('app app-a is-region');
  observerOf('.st-h').reportStep(5);
  expect(mapFrame.className).toBe('app app-a is-local is-sm');
  expect(listHeader()).toBe('Gap in Mar 2024');
  wait(20_000);
  expect(listHeader()).toBe('Gap in Mar 2024');
  // The dots do not ease with reduced motion, whoever set the month.
  expect(storyCss).toContain('@media (prefers-reduced-motion:reduce){.twmap .tl-fill,.twmap .tl-cur,.twmap .app.is-sm .dot{transition:none}');
});

test('the reduced-motion CSS keeps the fades and drops the movement', () => {
  expect(mapCss).toContain('@media (prefers-reduced-motion:reduce){.twmap .world,.twmap .dot,.twmap .mk,.twmap .ch-cur{transition:none}.twmap .mk-pos,.twmap .app.is-local .mk-pos{transform:none}.twmap .app.is-local .mk-pos{transition:opacity 200ms var(--eo)}');
  expect(mapCss).toContain('@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){.twmap .mk-pos.is-hov.is-ptr .mk{transform:scale(1.25)}}');
});

test('choosing a town from the list zooms the map and opens its panel, with focus kept on the list', () => {
  const { mapFrame, world } = renderMap();
  expect(world.style.transform).toBe(cameraTransform(REGION));
  const hanover = row('Hanover, NH');
  act(() => { hanover.focus(); });
  fireEvent.click(hanover);

  expect(world.style.transform).toBe(cameraTransform(cameraFor(town('hanover-nh').shape.bbox)));
  expect(mapFrame.className).toContain('is-zoomed');
  expect(document.querySelector('.m-selt')?.getAttribute('d')).toBe(town('hanover-nh').shape.d);
  expect(document.querySelector('.ztag')?.textContent).toBe('Hanover, NH');
  expect(hanover.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(hanover);

  const card = panel();
  expect(within(card).getByRole('heading', { name: 'Hanover, NH' })).toBeTruthy();
  expect(card.textContent).toContain('College town');
  expect(card.textContent).toContain('Moves with the region; biggest gap with the region in May, −7.3 index points.');
  // The gap for the month, the county against the Northeast, and both curves drawn.
  expect(card.querySelector('.bv-v')?.textContent).toBe('−7.3');
  expect(card.querySelector('.bv-l')?.textContent).toBe('below the Northeast, index points, May 2024');
  expect(card.querySelector('.bv-s')?.textContent).toBe('Grafton County 95.0 · Northeast 102.2');
  expect(card.querySelector('.ch-town')?.getAttribute('d')).toMatch(/^M12 /);
  expect(card.querySelector('.ch-ne')?.getAttribute('d')).toMatch(/^M12 /);
  expect(within(screen.getByRole('radiogroup', { name: 'Month' })).getByRole('radio', { checked: true }).textContent).toBe('May');
  expect(document.querySelector('[aria-live="polite"]')?.textContent)
    .toBe('Hanover, NH: Moves with the region; biggest gap with the region in May, −7.3 index points.');
  // Its drivers and dates link their sources: public institutions by host, other sites as "Source".
  const notes = document.getElementById(hanover.getAttribute('aria-controls')?.split(' ')[1] ?? '');
  expect(within(notes ?? document.body).getAllByRole('link', { name: 'registrar.dartmouth.edu' }).length).toBeGreaterThan(0);
});

test('a marker click zooms the same way and moves focus to the town’s list button', () => {
  const { world } = renderMap();
  const button = markerButton('Nantucket, MA');
  expect(button.getAttribute('aria-hidden')).toBe('true');
  expect(button.tabIndex).toBe(-1);
  fireEvent.click(button, { detail: 1 });
  expect(world.style.transform).toBe(cameraTransform(cameraFor(town('nantucket-ma').shape.bbox)));
  expect(document.activeElement).toBe(row('Nantucket, MA'));
  expect(within(panel()).getByRole('heading', { name: 'Nantucket, MA' })).toBeTruthy();
  expect(panel().querySelector('.bv-v')?.textContent).toBe('+93.5');
});

test('a pointer click goes to the town whose dot is nearest it, even on a neighbor’s overlapping button', () => {
  renderMap();
  const box = document.querySelector<HTMLElement>('.map-box');
  if (box === null) throw new Error('no map box');
  // A 356px phone map at the top left of the window.
  box.getBoundingClientRect = () => ({ left: 0, top: 0, right: 356, bottom: 309.72, width: 356, height: 309.72, x: 0, y: 0, toJSON: () => null });
  const at = (id: string): { clientX: number; clientY: number } => {
    const [x, y] = town(id).shape.centroid;
    return { clientX: (x / 1000) * 356, clientY: (y / 870) * 309.72 };
  };
  // Burlington's 44px button covers Stowe's dot 12px away: a tap on Stowe's dot opens Stowe.
  fireEvent.click(markerButton('Burlington, VT'), { detail: 1, ...at('stowe-vt') });
  expect(document.activeElement).toBe(row('Stowe, VT'));
  expect(row('Stowe, VT').getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(row('Stowe, VT'));
  // From the keyboard (detail 0) the button's own town, wherever the event says it is.
  fireEvent.click(markerButton('Middlebury, VT'), { detail: 0, ...at('stowe-vt') });
  expect(row('Middlebury, VT').getAttribute('aria-pressed')).toBe('true');
});

test('under 900px the card scrolls into view, smoothly only for a pointer, and not after the map is gone', () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (media: string) => ({ media, matches: media === '(max-width: 899px)', addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const scrolls: (ScrollBehavior | undefined)[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: (options?: ScrollIntoViewOptions) => { scrolls.push(options?.behavior); },
  });
  const view = render(<NortheastMap />);
  fireEvent.click(row('Ithaca, NY'), { detail: 1 });
  wait(30);
  // Enter or Space on a row reports detail 0: a keyboard action does not animate.
  fireEvent.click(row('Stowe, VT'), { detail: 0 });
  wait(30);
  expect(scrolls).toEqual(['smooth', 'auto']);
  fireEvent.click(row('Ithaca, NY'), { detail: 1 });
  view.unmount();
  // Unmounting cancels the pending scroll's timer with the rest.
  expect(jest.getTimerCount()).toBe(0);
  wait(30);
  expect(scrolls).toEqual(['smooth', 'auto']);
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

test('the map’s Back returns to the region and puts focus back on the town’s list button without scrolling', () => {
  const { mapFrame, world } = renderMap();
  fireEvent.click(row('Ithaca, NY'));
  const ithaca = row('Ithaca, NY');
  const focus = jest.spyOn(ithaca, 'focus');
  const [mapBack] = screen.getAllByRole('button', { name: 'Back to the Northeast' });
  if (mapBack === undefined) throw new Error('no Back');
  fireEvent.click(mapBack);
  expect(world.style.transform).toBe(cameraTransform(REGION));
  expect(mapFrame.className).toContain('is-back');
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(within(panel()).getByRole('heading', { name: 'Northeast, 2024' })).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: 'Back to the Northeast' })).toEqual([]);
});

test('the month scrubber is a radiogroup with one tab stop that follows the arrow keys, Home and End', () => {
  renderMap();
  const radios = within(screen.getByRole('radiogroup', { name: 'Month' })).getAllByRole('radio');
  expect(radios.map((radio) => radio.textContent)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  const checked = (): number => radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true');
  const tabStops = (): number[] => radios.flatMap((radio, index) => (radio.tabIndex === 0 ? [index] : []));
  expect(checked()).toBe(6);
  expect(tabStops()).toEqual([6]);

  const press = (key: string, expected: number): void => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
    expect(checked()).toBe(expected);
    expect(document.activeElement).toBe(radios[expected]);
    expect(tabStops()).toEqual([expected]);
  };
  act(() => { radios[6]?.focus(); });
  press('ArrowRight', 7);
  expect(listHeader()).toBe('Gap in Aug 2024');
  expect(panel().querySelector('.bv-l')?.textContent).toBe('Northeast, Aug 2024');
  press('ArrowDown', 8);
  press('ArrowLeft', 7);
  press('ArrowUp', 6);
  press('Home', 0);
  press('ArrowLeft', 11);
  press('ArrowRight', 0);
  press('End', 11);
  // Other keys do nothing.
  press('a', 11);
});

test('Escape inside the map resets a zoomed town and returns focus to its list button, with no document listener', () => {
  const onDocument = jest.spyOn(document, 'addEventListener');
  const onWindow = jest.spyOn(window, 'addEventListener');
  const { world } = renderMap();
  fireEvent.click(row('Bar Harbor, ME'));
  const zoomed = world.style.transform;
  expect(zoomed).not.toBe(cameraTransform(REGION));

  // Outside the map, Escape does nothing.
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(world.style.transform).toBe(zoomed);

  // Anywhere inside it, Escape returns to the region.
  const may = within(screen.getByRole('radiogroup', { name: 'Month' })).getByRole('radio', { checked: true });
  act(() => { may.focus(); });
  fireEvent.keyDown(may, { key: 'Escape' });
  expect(world.style.transform).toBe(cameraTransform(REGION));
  expect(document.activeElement).toBe(row('Bar Harbor, ME'));
  expect(row('Bar Harbor, ME').getAttribute('aria-pressed')).toBe('false');
  expect(within(panel()).getByRole('heading', { name: 'Northeast, 2024' })).toBeTruthy();
  // The name tag the refocused row would show is dismissed too.
  expect(document.querySelectorAll('.is-hov')).toHaveLength(0);
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('');

  const keydown = (spy: jest.SpyInstance): unknown[] => spy.mock.calls.filter(([type]) => type === 'keydown');
  expect(keydown(onDocument)).toEqual([]);
  expect(keydown(onWindow)).toEqual([]);
});

test('Escape dismisses a hovered marker’s name tag', () => {
  renderMap();
  const conway = marker('Conway, NH');
  fireEvent.mouseEnter(conway);
  expect(conway.className).toContain('is-hov is-ptr');
  fireEvent.keyDown(row('Conway, NH'), { key: 'Escape' });
  expect(conway.className).not.toContain('is-hov');
});

test('the town list is the keyboard path: twelve buttons in two groups, with markers hidden from assistive tech', () => {
  renderMap();
  const rows = mapTowns.map((candidate) => row(candidate.label));
  expect(rows).toHaveLength(12);
  for (const button of rows) {
    expect(button.tagName).toBe('BUTTON');
    for (const id of button.getAttribute('aria-controls')?.split(' ') ?? []) expect(document.getElementById(id)).not.toBeNull();
  }
  expect(screen.getByText('College').closest('.grp')?.querySelectorAll('.row')).toHaveLength(6);
  expect(screen.getByText('Seasonal and event').closest('.grp')?.querySelectorAll('.row')).toHaveLength(6);
  expect(screen.getByText('Same scale within this group: 80 to 115')).toBeTruthy();
  for (const button of document.querySelectorAll<HTMLButtonElement>('.mk')) {
    expect(button.getAttribute('aria-hidden')).toBe('true');
    expect(button.tabIndex).toBe(-1);
  }
  expect(document.querySelectorAll('.mk')).toHaveLength(12);
  // Every other focusable element in the map is a real button or link (the card takes focus only from
  // "Details below", and the numbers table is a scrollable region).
  const focusable = [...document.querySelectorAll<HTMLElement>('.twmap button, .twmap a, .twmap [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && element.getAttribute('role') !== 'region');
  expect(focusable.every((element) => element.tagName === 'BUTTON' || element.tagName === 'A')).toBe(true);
  // The story adds no control: the Region / Towns toggle is gone, and the list is introduced by its heading.
  expect(screen.queryByRole('group', { name: 'Region / Towns' })).toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'Pick a town to compare it with the Northeast' })).toBeTruthy();
});

test('the story and the caption say the map shows BLS QCEW restaurant and bar jobs, not a forecast', () => {
  renderMap();
  const first = screen.getByRole('heading', { level: 2, name: 'The Northeast, as one pattern.' }).parentElement;
  expect(first?.querySelector('.eyebrow')?.textContent).toBe('What the map shows');
  expect(first?.textContent).toContain('Restaurant and bar jobs in each town’s county, month by month in 2024, compared with the Northeast. Public data from the U.S. Bureau of Labor Statistics (QCEW), not a Townwise forecast.');
  expect(screen.getByText('Restaurant and bar jobs by county, 2024. Public data (BLS QCEW). Not a forecast.').className).toBe('eyebrow pin-cap');
  expect(screen.getByRole('img', { name: /^Map of the nine Northeast states with twelve featured towns/ })).toBeTruthy();
  expect(screen.getAllByText('Historical public data, not a Townwise forecast.')).toHaveLength(1);
  expect(document.body.textContent).not.toMatch(/sales of|revenue|\$/);
});

test('the map figure fills the pane on phones instead of collapsing to zero width', () => {
  // A column-flex .pane-map with an auto-margined, inline-size container figure sized the figure (and the map) to 0px.
  expect(mapCss).not.toMatch(/\.pane-map\{[^}]*(display:flex|flex-direction|min-height)/);
  expect(mapCss).toMatch(/\.twmap \.map-fig\{width:100%;max-width:1040px;margin-inline:auto;/);
});

test('on phones the card’s sentences are body size and the notes’ longer mono lines 14px', () => {
  expect(mapCss).toContain('@media (max-width:640px){.twmap .cp,.twmap .pat,.twmap .tx,.twmap .why li{font-size:16px;line-height:24px}.twmap .cav li,.twmap .fine,.twmap .srcs a{font-size:14px;line-height:20px}}');
  // The rule comes after the base sizes, so it wins at the same specificity.
  expect(mapCss.indexOf('.twmap .cav li,.twmap .fine{')).toBeLessThan(mapCss.indexOf('.twmap .cav li,.twmap .fine,.twmap .srcs a{font-size:14px'));
  expect(mapCss.indexOf('.twmap .cp{')).toBeLessThan(mapCss.indexOf('.twmap .cp,.twmap .pat,'));
});

test('the map CSS follows the motion rules', () => {
  expect(mapCss).not.toMatch(/transition:\s*all/);
  expect(mapCss).not.toMatch(/ease-in(?!-out)/);
  expect(mapCss).not.toMatch(/scale\(0\)/);
  expect(mapCss).toContain('.twmap{--eio:cubic-bezier(0.77,0,0.175,1)}');
  expect(mapCss).toContain('.twmap .world{transform-box:view-box;transform-origin:0 0;transition:transform 280ms var(--eio)}');
  // A keyboard change does not animate: the zoom, values, rows and months jump, a row focused from the keyboard
  // shows its marker's name tag at once, and only a pointer fades the tag in.
  const keyboardRule = `${/(\.twmap \.app\.is-kb [^{]*)\{transition:none !important;animation:none !important\}/.exec(mapCss)?.[1] ?? ''},`;
  for (const part of ['.world', '.ch-cur', '.mk-pos', '.list-m', '.row-v', '.bv-v', '.cb', '.row', '.sb']) {
    expect(keyboardRule).toContain(`.twmap .app.is-kb ${part},`);
  }
  expect(mapCss).toContain('.twmap .row:focus-visible,.twmap .row:focus-visible *{transition:none}');
  expect(mapCss).toContain('.twmap .mk-pos.is-ptr .mtag{transition:opacity 120ms ease}');
  // Interface transitions stay under 300ms; only the one-time intro runs longer (the draw-in, 900ms).
  const durations = [...mapCss.matchAll(/transition:([^;}]*)/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/(\d+)ms/g)].map((ms) => Number(ms[1])));
  expect(durations.filter((ms) => ms >= 300)).toEqual([900, 400, 500]);
  // Each county series feeds one marker.
  expect(countySeries.map((series) => series.townId).sort()).toEqual(mapTowns.map((candidate) => candidate.id).sort());
});
