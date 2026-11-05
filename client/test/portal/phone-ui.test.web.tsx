import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';
import { View } from 'react-native';

import { FilterTabs } from '../../src/portal/console/parts';
import { locationTabs } from '../../src/portal/routing';
import { LocationTabs } from '../../src/portal/shell/LocationShell';
import { PortalStyles } from '../../src/portal/shell/PortalStyles';
import { LinkButton } from '../../src/portal/ui/Button';
import { DataTable, MIN_FLEX_WIDTH, type Column } from '../../src/portal/ui/DataTable';
import { Select } from '../../src/portal/ui/Select';

// The shared pieces as a phone and a tablet draw them on web, through the real expo-router <Link asChild>
// (src/portal/ui/hover.ts): the styles that reach the DOM, which is what the browser lays out.

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

/** Renders `node` as a page of a small router, so its links are real expo-router links. */
function renderLinked(node: React.ReactNode): void {
  render(<ExpoRoot context={getMockContext({ index: () => <View>{node}</View>, other: () => null })} location="/" />);
}

function style(element: Element): CSSStyleDeclaration {
  return window.getComputedStyle(element);
}

function nth(elements: HTMLElement[], index: number): HTMLElement {
  const element = elements.at(index);
  if (element === undefined) throw new Error(`no element at ${String(index)}`);
  return element;
}

/** jsdom has no PointerEvent, so react-native-web listens for mouseenter. */
function hover(element: Element): void {
  fireEvent.mouseEnter(element);
}

const RAISED = 'rgb(24, 28, 33)';
const BORDER = 'rgb(52, 56, 62)';
const LINE = 'rgb(123, 129, 135)';
const WHITE = 'rgb(239, 242, 246)';

test('LinkButton keeps its box through Link asChild: 44px tall, the outline’s 1px line, white on hover', () => {
  renderLinked(
    <>
      <LinkButton variant="outline" href="/other" label="Add location" />
      <LinkButton href="/other" label="See the audit log" />
    </>,
  );
  const outline = screen.getByRole('link', { name: 'Add location' });
  expect(style(outline).minHeight).toBe('44px');
  expect(style(outline).borderTopWidth).toBe('1px');
  expect(style(outline).borderTopColor).toBe(LINE);
  expect(style(outline).paddingLeft).toBe('14px');
  hover(outline);
  expect(style(outline).borderTopColor).toBe(WHITE);
  expect(style(screen.getByRole('link', { name: 'See the audit log' })).minHeight).toBe('44px');
});

test('the location tabs: 44px links in a row, the selected one filled and outlined, a raised fill on hover, inside the margins', () => {
  renderLinked(<LocationTabs tabs={locationTabs('l1', 'org_admin', '/locations/l1/notes')} />);
  const nav = screen.getByRole('navigation', { name: 'Location' });
  const notes = within(nav).getByRole('link', { name: 'Notes' });
  expect(notes.getAttribute('aria-current')).toBe('page');
  expect(style(notes).minHeight).toBe('44px');
  expect(style(notes).flexDirection).toBe('row');
  expect(style(notes).backgroundColor).toBe(RAISED);
  expect(style(notes).borderTopWidth).toBe('1px');
  expect(style(notes).borderTopColor).toBe(BORDER);
  const town = within(nav).getByRole('link', { name: 'Town' });
  expect(style(town).minHeight).toBe('44px');
  expect(style(town).backgroundColor).not.toBe(RAISED);
  hover(town);
  expect(style(town).backgroundColor).toBe(RAISED);
  // The row's 4px padding stays inside the region, which no longer reaches 4px past the content's edges.
  expect(style(screen.getByRole('region', { name: 'Location sections' })).marginLeft).toBe('0px');
  expect(style(screen.getByRole('region', { name: 'Location sections' })).marginRight).toBe('0px');
});

test('the console’s status filters are styled as the location tabs, inside the margins', () => {
  renderLinked(
    <FilterTabs
      label="Requests by status"
      tabs={[
        { label: 'Pending 2', href: '/other', current: true },
        { label: 'Approved', href: '/other?status=approved', current: false },
      ]}
    />,
  );
  const nav = screen.getByRole('navigation', { name: 'Requests by status' });
  const pending = within(nav).getByRole('link', { name: 'Pending 2' });
  expect(style(pending).minHeight).toBe('44px');
  expect(style(pending).flexDirection).toBe('row');
  expect(style(pending).backgroundColor).toBe(RAISED);
  const approved = within(nav).getByRole('link', { name: 'Approved' });
  expect(style(approved).minHeight).toBe('44px');
  hover(approved);
  expect(style(approved).backgroundColor).toBe(RAISED);
  expect(style(nav).marginLeft).toBe('0px');
});

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name', flex: 1.6 }, { key: 'status', label: 'Status' }, { key: 'admins', label: 'Admins', numeric: true },
  { key: 'members', label: 'Members', numeric: true }, { key: 'invited', label: 'Invited', numeric: true },
  { key: 'locations', label: 'Locations', numeric: true }, { key: 'days', label: 'Days of sales', numeric: true },
  { key: 'upload', label: 'Last upload' }, { key: 'created', label: 'Created' },
];
const EMAIL = ['dana.whitfield', 'birchwoodbistro.test'].join('@');
const ROWS = ['Harbor Light Chowder House', 'Pinecrest Diner Co.'].map((name, index) => ({
  key: String(index),
  cells: { name, status: 'Suspended', admins: '1', members: EMAIL, invited: '0', locations: '2', days: '445', upload: 'None yet', created: 'Nov 5, 2026' },
}));

test('a stacked table on phones puts each label above its value, and the last row has no rule of its own', () => {
  renderLinked(<DataTable label="Organizations" columns={COLUMNS} rows={ROWS} />);
  const items = within(screen.getByRole('region', { name: 'Organizations' })).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  const label = within(nth(items, 0)).getByText('Members');
  const value = within(nth(items, 0)).getByText(EMAIL);
  const pair = label.parentElement;
  if (pair === null) throw new Error('no pair');
  // Label, then value, in a column: the value has the row's full width instead of 60% of it.
  expect(style(pair).flexDirection).toBe('column');
  expect(pair.contains(value)).toBe(true);
  expect(label.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // A Section after the table draws the rule between them.
  expect(style(nth(items, 0)).borderBottomWidth).toBe('1px');
  expect(style(nth(items, 1)).borderBottomWidth).toBe('0px');
});

test('from 641px a table keeps a minimum width, so its focusable region scrolls sideways instead of squeezing nine columns', () => {
  setWidth(768);
  renderLinked(<DataTable label="Organizations" columns={COLUMNS} rows={ROWS} />);
  const region = screen.getByRole('region', { name: 'Organizations' });
  expect(region.getAttribute('tabindex')).toBe('0');
  expect(style(region).overflowX).toBe('auto');
  const content = region.firstElementChild as HTMLElement;
  expect(within(content).getByRole('table')).toBeTruthy();
  const minWidth = parseFloat(style(content).minWidth);
  // Nine columns, 9.6 units of flex: wider than the 704px of content at 768px, so a header like “Locations” keeps
  // its 9 characters on one line.
  expect(minWidth).toBe(Math.ceil(9.6 * MIN_FLEX_WIDTH));
  expect(minWidth).toBeGreaterThan(768 - 2 * 32);
  expect(MIN_FLEX_WIDTH).toBeGreaterThanOrEqual('Locations'.length * 0.6 * 12 + 8 + 16);
  const rows = within(region).getAllByRole('row');
  expect(style(nth(rows, -2)).borderBottomWidth).toBe('1px');
  expect(style(nth(rows, -1)).borderBottomWidth).toBe('0px');
});

test('a selected last row keeps its whole outline', () => {
  setWidth(768);
  renderLinked(<DataTable label="Organizations" columns={COLUMNS} rows={ROWS.map((row, index) => ({ ...row, selected: index === 1 }))} />);
  const last = nth(within(screen.getByRole('region', { name: 'Organizations' })).getAllByRole('row'), -1);
  expect(style(last).borderBottomWidth).toBe('1px');
  expect(style(last).borderTopWidth).toBe('1px');
});

test('a select ends a long choice with an ellipsis instead of cutting it off (the location switcher)', () => {
  renderLinked(
    <Select
      label="Location"
      compact
      value="l1"
      items={[{ value: 'l1', label: 'The Old Mill Tavern and Riverside Dining Room at Ledyard Bridge' }, { value: 'l2', label: 'River Grill' }]}
      onChange={() => undefined}
    />,
  );
  const select = screen.getByRole('combobox', { name: 'Location' });
  expect(select.style.textOverflow).toBe('ellipsis');
  expect(select.style.whiteSpace).toBe('nowrap');
  expect(select.style.overflow).toBe('hidden');
});

test('the portal’s stylesheet sets grayscale antialiasing on its root, as the boards do, and adds no script', () => {
  const scripts = document.querySelectorAll('script').length;
  render(<PortalStyles />);
  const css = [...document.querySelectorAll('style')].map((element) => element.textContent).find((text) => text.includes('#tw-portal'));
  expect(css).toContain('#tw-portal{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}');
  expect(document.querySelectorAll('script')).toHaveLength(scripts);
});
