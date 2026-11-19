import { act, cleanup, render, screen, within } from '@testing-library/react';

import { InTown } from '../../../src/portal/home/InTown';
import { theme } from '../../../src/theme';
import { ACCESS, meOf } from '../../helpers/portal';
import { analyticsFake } from '../analytics/fakes';
import { LOCATION_ID, NOVEMBER, PEOPLE_PATH } from '../estimates/fakes';
import { portalWrapper } from '../files/harness';

// Who's in town on web at phone width (spec 15.7: one column, no horizontal scroll): each row puts its date over its
// words instead of beside them, and the block reads the same words at every width. Synthetic data only.

let width = 375;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  setWidth(375);
});

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).parentElement;
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
}

test('at phone width a row stacks its date over its words; wide, they sit side by side; the words never change', async () => {
  const Wrapper = portalWrapper(analyticsFake({ [PEOPLE_PATH]: NOVEMBER }), meOf(ACCESS.member));
  render(<Wrapper><InTown today="2026-11-05" townId="hanover-nh" locationId={LOCATION_ID} /></Wrapper>);
  await screen.findByText('Nov 20 to 25');
  expect(window.getComputedStyle(rowOf('Nov 20 to 25')).flexDirection).toBe('column');
  const phone = document.body.textContent;
  setWidth(1280);
  expect(window.getComputedStyle(rowOf('Nov 20 to 25')).flexDirection).toBe('row');
  expect(document.body.textContent).toBe(phone);
});

test('while it loads, the groups’ skeleton stands in above the jobs, with one status line and only masked words', async () => {
  const api = analyticsFake({});
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => (path === PEOPLE_PATH ? new Promise(() => undefined) : json(path, schema, opts));
  const Wrapper = portalWrapper(api, meOf(ACCESS.member));
  render(<Wrapper><InTown today="2026-11-05" townId="hanover-nh" locationId={LOCATION_ID} /></Wrapper>);
  const skeleton = await screen.findByTestId('skeleton-in-town');
  expect(within(skeleton).getByRole('status').textContent).toBe('Loading who’s in town…');
  // The shapes draw the page's sentences to wrap like them, every letter and digit masked as one letter (s, or x on plain lines).
  const shapes = skeleton.textContent.replace('Loading who’s in town…', '');
  expect(shapes).not.toBe('');
  expect(shapes).toMatch(/^[^\p{L}\p{N}]*(?:[sx][^\p{L}\p{N}]*)*$/u);
  // The county's jobs don't wait for the read, so they sit under the shapes already.
  const jobs = screen.getByText('Food-service jobs in Grafton County');
  expect(skeleton.compareDocumentPosition(jobs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

/**
 * What the element's own class rules set for `property`, the last rule winning. jsdom's computed style lets the base
 * text class's `font` shorthand beat react-native-web's later font rules, so fonts are read from the rules.
 */
function classValue(element: Element, property: string): string | null {
  let found: string | null = null;
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      // react-native-web's own rules are one class each.
      if (!(rule instanceof CSSStyleRule) || !rule.selectorText.startsWith('.') || !element.classList.contains(rule.selectorText.slice(1))) continue;
      const value = rule.style.getPropertyValue(property);
      if (value !== '') found = value;
    }
  }
  return found;
}

test('each row’s dates are in the mono type, as dates are elsewhere on Home', async () => {
  const Wrapper = portalWrapper(analyticsFake({ [PEOPLE_PATH]: NOVEMBER }), meOf(ACCESS.member));
  render(<Wrapper><InTown today="2026-11-05" townId="hanover-nh" locationId={LOCATION_ID} /></Wrapper>);
  const when = await screen.findByText('Nov 20 to 25');
  expect(classValue(when, 'font-family')).toMatch(/^"Geist Mono"/);
  expect(classValue(when, 'font-size')).toBe(`${String(theme.type.mono.fontSize)}px`);
  expect(classValue(when, 'line-height')).toBe(`${String(theme.type.mono.lineHeight)}px`);
});
