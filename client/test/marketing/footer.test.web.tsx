import { act, cleanup, render, screen, within } from '@testing-library/react';

import { Footer } from '../../src/marketing/Footer.web';
import { css } from '../../src/marketing/styles.web';

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
  jest.useRealTimers();
  FakeObserver.instances = [];
  Reflect.deleteProperty(window, 'IntersectionObserver');
  Reflect.deleteProperty(window, 'matchMedia');
});

function renderFooter(root: Element | null = null): HTMLElement {
  render(<Footer root={{ current: root as HTMLElement | null }} />);
  return screen.getByRole('contentinfo');
}

function onlyObserver(): FakeObserver {
  expect(FakeObserver.instances).toHaveLength(1);
  const [observer] = FakeObserver.instances;
  if (observer === undefined) throw new Error('no observer');
  return observer;
}

test('armed, the letters wait below the edge, but the links stay readable and focusable', () => {
  installObserver();
  const footer = renderFooter();
  expect(footer.className).toBe('ft is-armed');
  const links = within(footer).getAllByRole('link');
  expect(links).toHaveLength(12);
  for (const link of links) {
    expect(link.closest('[aria-hidden="true"]')).toBeNull();
    expect(link.closest('[hidden]')).toBeNull();
    expect(link.getAttribute('href')).not.toBeNull();
  }
  const word = footer.querySelector('.ft-word');
  expect(word?.getAttribute('aria-hidden')).toBe('true');
  expect(word?.textContent).toBe('TOWNWISE');
});

test('the bottom line names Townwise as the copyright holder and keeps the student-project line, with no placeholder', () => {
  const footer = renderFooter();
  expect([...footer.querySelectorAll('.ft-bot p')].map((line) => line.textContent)).toEqual([
    '© 2026 Townwise',
    'Townwise is a student project. It is not an official Dartmouth product.',
  ]);
  expect(footer.querySelector('.chip')).toBeNull();
  expect(footer.querySelector('.ft-dec')).toBeNull();
});

test('the letters rise once the footer is in view, and the observer disconnects', () => {
  installObserver();
  const root = document.createElement('div');
  const footer = renderFooter(root);
  const observer = onlyObserver();
  expect(observer.observed).toEqual([footer]);
  expect(observer.options?.root).toBe(root);
  observer.report(false, 0);
  expect(footer.className).toBe('ft is-armed');
  observer.report(true, 0.3);
  expect(footer.className).toBe('ft is-armed is-in');
  expect(observer.disconnected).toBe(true);
});

test('the watchdog reveals the letters when the observer never reports', () => {
  jest.useFakeTimers();
  installObserver();
  const footer = renderFooter();
  act(() => { jest.advanceTimersByTime(999); });
  expect(footer.className).toBe('ft is-armed');
  act(() => { jest.advanceTimersByTime(1); });
  expect(footer.className).toBe('ft is-armed is-in');
});

test('without IntersectionObserver the letters are never hidden', () => {
  const footer = renderFooter();
  expect(footer.className).toBe('ft is-in');
});

test('focus inside the footer reveals the letters at once, without animating', () => {
  installObserver();
  const footer = renderFooter();
  act(() => { within(footer).getByRole('link', { name: 'Privacy' }).focus(); });
  expect(footer.className).toBe('ft is-armed is-in is-now');
  expect(css).toContain('.ft.is-now .ft-word span{transition:none}');
});

test('with reduced motion the letters show at once, with no observer and no movement', () => {
  installObserver();
  prefersReducedMotion(true);
  const footer = renderFooter();
  expect(footer.className).toBe('ft is-armed is-in');
  expect(FakeObserver.instances).toHaveLength(0);
  // The hidden state exists only for no-preference; reduce drops the movement.
  expect(css).toContain('@media screen and (prefers-reduced-motion:no-preference){.ft.is-armed:not(.is-in) .ft-word span{transform:translateY(100%);transition:none}}');
  expect(css).toContain('@media (prefers-reduced-motion:reduce){.ft-word span{transform:none;transition:none}');
});

test('without a reduced-motion preference the letters wait for the observer', () => {
  installObserver();
  prefersReducedMotion(false);
  const footer = renderFooter();
  expect(footer.className).toBe('ft is-armed');
  expect(FakeObserver.instances).toHaveLength(1);
});

test('the letters rise from the centre out, 50ms apart, on the entering curve, under 900ms in all', () => {
  const footer = renderFooter();
  const delays = [...footer.querySelectorAll<HTMLElement>('.ft-word span')].map((span) => span.style.transitionDelay);
  expect(delays).toEqual(['150ms', '100ms', '50ms', '0ms', '0ms', '50ms', '100ms', '150ms']);
  expect(css).toContain('--eo:cubic-bezier(0.23,1,0.32,1)');
  expect(css).toContain('.ft-word span{display:block;line-height:1;margin-bottom:calc(var(--base) * -1em);transition:transform 700ms var(--eo)}');
});

test('the marketing CSS follows the motion rules', () => {
  expect(css).not.toMatch(/transition:\s*all/);
  expect(css).not.toMatch(/ease-in(?!-out)/);
  expect(css).not.toMatch(/scale\(0\)/);
  expect(css).toContain('.btn:active{transform:scale(.97)}');
  expect(css).toContain('@media (prefers-reduced-motion:reduce){.ft-word span{transform:none;transition:none}.btn:active{transform:none}}');
});
