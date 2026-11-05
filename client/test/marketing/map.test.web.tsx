import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { cameraFor, cameraTransform, REGION } from '../../src/marketing/map/camera';
import { countySeries } from '../../src/marketing/map/countyData';
import { mapTowns, markerScale, REST_MONTH } from '../../src/marketing/map/mapState';
import { mapCss } from '../../src/marketing/map/mapStyles.web';
import { NortheastMap } from '../../src/marketing/map/NortheastMap.web';

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

function monthShown(): string | null | undefined {
  return document.querySelector('.mon-l')?.textContent;
}

function listHeader(): string | null | undefined {
  return document.querySelector('.list-h')?.textContent;
}

function row(label: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: new RegExp(`^${label}`) });
}

function marker(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.mk-pos')].find((element) => element.textContent === label);
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

// Through the intro: the draw starts 450ms after mount, runs 900ms, then the towns appear on January.
function playToJanuary(): void {
  wait(450);
  wait(900);
}

// From January to the rest month. Each step is scheduled once the one before it has rendered.
function playToRest(): void {
  wait(1000);
  for (let month = 1; month < 11; month += 1) wait(500);
  wait(800);
}

const NANTUCKET_GAPS = town('nantucket-ma').series.gap;

test('the outlines draw in once the map is in view, then the towns appear and the year plays January to December', () => {
  installObserver();
  const { mapFrame } = renderMap();
  // Before the map is in view the outlines wait, hidden.
  expect(mapFrame.className).toBe('app is-region is-pre');
  const [observer] = FakeObserver.instances;
  if (observer === undefined) throw new Error('no observer');
  expect(observer.observed).toEqual([document.querySelector('.map-box')]);
  observer.report(true, 0.5);
  expect(observer.disconnected).toBe(true);

  wait(450);
  expect(mapFrame.className).toBe('app is-region is-run');
  expect(document.querySelector<SVGPathElement>('.m-draw')?.style.strokeDashoffset).toBe('0');
  wait(900);
  expect(document.querySelector('.m-draw')).toBeNull();
  expect(mapFrame.className).toBe('app is-local is-play');
  expect(monthShown()).toBe('Jan 2024');
  expect(screen.getByRole('button', { name: 'Pause the year' }).textContent).toBe('Pause');

  // Each marker's scale follows that month's gap, and the scale eases only while the year plays.
  const nantucket = marker('Nantucket, MA');
  const scale = (): number => Number(nantucket.style.getPropertyValue('--k'));
  expect(scale()).toBeCloseTo(markerScale(NANTUCKET_GAPS[0] ?? 0), 3);
  expect(mapCss).toContain('.twmap .app.is-play .dot{transition:transform 280ms var(--eio)}');
  // The markers enter one by one, west to east.
  const order = [...document.querySelectorAll<HTMLElement>('.mk-pos')].map((element) => Number(element.style.getPropertyValue('--i')));
  expect([...order].sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
  expect(mapCss).toContain('calc(var(--dz,0ms) + var(--i) * var(--stg,50ms))');

  // January holds while the markers enter; then 500ms a month; December holds 800ms before the rest.
  wait(999);
  expect(monthShown()).toBe('Jan 2024');
  wait(1);
  expect(monthShown()).toBe('Feb 2024');
  expect(scale()).toBeCloseTo(markerScale(NANTUCKET_GAPS[1] ?? 0), 3);
  for (const label of ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']) {
    wait(500);
    expect(monthShown()).toBe(`${label} 2024`);
  }
  expect(listHeader()).toBe('Gap in Dec 2024');
  wait(799);
  expect(monthShown()).toBe('Dec 2024');
  wait(1);

  // The year rests on the month with the widest spread of gaps, computed from the data: July 2024.
  expect(REST_MONTH).toBe(6);
  expect(monthShown()).toBe('Jul 2024');
  expect(scale()).toBe(1);
  expect(screen.getByRole('button', { name: 'Play the year' }).textContent).toBe('Play');
  wait(10_000);
  expect(monthShown()).toBe('Jul 2024');
});

test('Pause stops the year where it is and Play resumes it', () => {
  renderMap();
  playToJanuary();
  wait(1000);
  expect(monthShown()).toBe('Feb 2024');
  fireEvent.click(screen.getByRole('button', { name: 'Pause the year' }));
  expect(screen.getByRole('button', { name: 'Play the year' }).textContent).toBe('Play');
  wait(5000);
  expect(monthShown()).toBe('Feb 2024');
  fireEvent.click(screen.getByRole('button', { name: 'Play the year' }));
  expect(screen.getByRole('button', { name: 'Pause the year' })).toBeTruthy();
  wait(300);
  expect(monthShown()).toBe('Mar 2024');
  wait(500);
  expect(monthShown()).toBe('Apr 2024');
});

test('Play after the year has come to rest plays it again from January', () => {
  renderMap();
  playToJanuary();
  playToRest();
  expect(monthShown()).toBe('Jul 2024');
  fireEvent.click(screen.getByRole('button', { name: 'Play the year' }));
  expect(monthShown()).toBe('Jan 2024');
  wait(500);
  expect(monthShown()).toBe('Feb 2024');
});

test('Pause leaves the month label alone: its animation never depends on the play state', () => {
  renderMap();
  playToJanuary();
  wait(1000);
  const before = document.querySelector('.mon-l')?.className;
  fireEvent.click(screen.getByRole('button', { name: 'Pause the year' }));
  expect(document.querySelector('.mon-l')?.className).toBe(before);
  // The play state sets only the rise and the length. A new animation-name would replay the label.
  expect(mapCss).toContain('.twmap .app.is-play .mon-l{--tk-y:6px;animation-duration:200ms}');
  expect(mapCss).not.toMatch(/is-play[^{]*\.mon-l[^{]*\{[^}]*animation(-name)?:/);
});

test.each([
  ['a town in the list', () => { fireEvent.click(row('Hanover, NH')); }, 'May'],
  ['a marker', () => { fireEvent.click(markerButton('Stowe, VT'), { detail: 1 }); }, 'May'],
  ['the Region toggle', () => { fireEvent.click(screen.getByRole('button', { name: 'Region' })); }, 'Feb'],
  ['the month scrubber', () => { fireEvent.click(screen.getByRole('radio', { name: 'Oct' })); }, 'Oct'],
])('using %s stops the year', (_name, use, month) => {
  const { mapFrame } = renderMap();
  playToJanuary();
  wait(1000);
  expect(monthShown()).toBe('Feb 2024');
  use();
  expect(mapFrame.className).not.toContain('is-play');
  expect(listHeader()).toBe(`Gap in ${month} 2024`);
  wait(10_000);
  expect(listHeader()).toBe(`Gap in ${month} 2024`);
});

test('with reduced motion the towns show the resting month at once: no draw-in and no playing year', () => {
  prefersReducedMotion(true);
  const { mapFrame } = renderMap();
  expect(mapFrame.className).toBe('app is-local');
  expect(document.querySelector('.m-draw')).toBeNull();
  expect(monthShown()).toBe('Jul 2024');
  expect(screen.queryByRole('button', { name: /the year$/ })).toBeNull();
  wait(20_000);
  expect(monthShown()).toBe('Jul 2024');
  expect(listHeader()).toBe('Gap in Jul 2024');
  expect(Number(marker('Nantucket, MA').style.getPropertyValue('--k'))).toBe(1);
});

test('with reduced motion and an observer, the outlines show at once and the towns wait for the map to be in view', () => {
  installObserver();
  prefersReducedMotion(true);
  const { mapFrame } = renderMap();
  expect(mapFrame.className).toBe('app is-region');
  FakeObserver.instances[0]?.report(true, 0.5);
  expect(mapFrame.className).toBe('app is-local');
  expect(monthShown()).toBe('Jul 2024');
  wait(20_000);
  expect(monthShown()).toBe('Jul 2024');
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
  expect(screen.getByRole('group', { name: 'Region / Towns' })).toBeTruthy();
});

test('the caption says the map shows BLS QCEW restaurant and bar jobs, not a forecast', () => {
  renderMap();
  expect(screen.getByText('What the map shows.').parentElement?.textContent).toBe(
    'What the map shows. Restaurant and bar jobs in each town’s county, month by month in 2024, compared with the Northeast. Public data from the U.S. Bureau of Labor Statistics (QCEW), not a Townwise forecast.',
  );
  expect(screen.getByText('Public data (BLS QCEW). Not a forecast.')).toBeTruthy();
  expect(screen.getByRole('img', { name: /^Map of the nine Northeast states with twelve featured towns/ })).toBeTruthy();
  expect(screen.getAllByText('Historical public data, not a Townwise forecast.')).toHaveLength(1);
  expect(document.body.textContent).not.toMatch(/sales of|revenue|\$/);
});

test('the map figure fills the pane on phones instead of collapsing to zero width', () => {
  // A column-flex .pane-map with an auto-margined, inline-size container figure sized the figure (and the map) to 0px.
  expect(mapCss).not.toMatch(/\.pane-map\{[^}]*(display:flex|flex-direction|min-height)/);
  expect(mapCss).toMatch(/\.twmap \.map-fig\{width:100%;max-width:1040px;margin-inline:auto;/);
});

test('the map CSS follows the motion rules', () => {
  expect(mapCss).not.toMatch(/transition:\s*all/);
  expect(mapCss).not.toMatch(/ease-in(?!-out)/);
  expect(mapCss).not.toMatch(/scale\(0\)/);
  expect(mapCss).toContain('.twmap{--eio:cubic-bezier(0.77,0,0.175,1)}');
  expect(mapCss).toContain('.twmap .world{transform-box:view-box;transform-origin:0 0;transition:transform 280ms var(--eio)}');
  expect(mapCss).toContain('.twmap .mon-b:active{transform:scale(.97)}');
  // A keyboard change does not animate: the zoom, values, toggle, rows and months jump, a row focused from
  // the keyboard shows its marker's name tag at once, and only a pointer fades the tag in.
  const keyboardRule = `${/(\.twmap \.app\.is-kb [^{]*)\{transition:none !important;animation:none !important\}/.exec(mapCss)?.[1] ?? ''},`;
  for (const part of ['.world', '.ch-cur', '.mk-pos', '.mon-l', '.row-v', '.bv-v', '.cb', '.tg button', '.row', '.sb']) {
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
