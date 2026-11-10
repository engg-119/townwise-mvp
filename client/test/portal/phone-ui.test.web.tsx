import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';
import { View } from 'react-native';

import { FilterTabs } from '../../src/portal/console/parts';
import { MonthsTable } from '../../src/portal/locations/MonthsTable';
import { clientNav } from '../../src/portal/routing';
import { PortalStyles } from '../../src/portal/shell/PortalStyles';
import { TopBar } from '../../src/portal/shell/TopBar';
import { LinkButton } from '../../src/portal/ui/Button';
import { DataTable, MIN_FLEX_WIDTH, type Column } from '../../src/portal/ui/DataTable';
import { Notice } from '../../src/portal/ui/feedback';
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

function parentOf(element: HTMLElement): HTMLElement {
  if (element.parentElement === null) throw new Error('no parent');
  return element.parentElement;
}

/** jsdom has no PointerEvent, so react-native-web listens for mouseenter. */
function hover(element: Element): void {
  fireEvent.mouseEnter(element);
}

const RAISED = 'rgb(24, 28, 33)';
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

function renderBar(path: string): void {
  renderLinked(<TopBar kind="client" email="a@example.com" orgName="Test Group" nav={clientNav('org_admin', path, 'l1')} onSignOut={() => undefined} />);
}

test('on a phone the sections take one row in a focusable region that scrolls sideways, into the margins, with 44px links', () => {
  renderBar('/locations/l1/notes');
  const region = screen.getByRole('region', { name: 'Sections' });
  expect(region.getAttribute('tabindex')).toBe('0');
  // The scroller reaches the screen's edges, and its row starts again at the 16px margin, so the first and last
  // link's focus ring is never cut off.
  expect(style(region).marginLeft).toBe('-16px');
  expect(style(region).marginRight).toBe('-16px');
  const nav = within(region).getByRole('navigation', { name: 'Main' });
  expect(style(parentOf(nav)).paddingLeft).toBe('16px');
  expect(style(nav).flexWrap).toBe('nowrap');
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
    'Home', 'Analytics', 'TownwiseAI', 'Notes', 'Town', 'Your data', 'Team', 'Settings',
  ]);
  const notes = within(nav).getByRole('link', { name: 'Notes' });
  expect(notes.getAttribute('aria-current')).toBe('page');
  expect(style(notes).minHeight).toBe('44px');
  expect(within(nav).getByRole('link', { name: 'Town' }).getAttribute('aria-current')).toBeNull();
});

test.each([768, 1279])('at %ipx the sections wrap in a second row under a rule, with Team and Settings at its far end', (at) => {
  setWidth(at);
  renderBar('/locations/l1/sales');
  expect(screen.queryByRole('region', { name: 'Sections' })).toBeNull();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  expect(style(parentOf(nav)).borderTopWidth).toBe('1px');
  expect(style(nav).flexWrap).toBe('wrap');
  expect(within(nav).getByRole('link', { name: 'Analytics' }).getAttribute('aria-current')).toBe('true');
  expect(style(parentOf(within(nav).getByRole('link', { name: 'Team' }))).marginLeft).toBe('auto');
});

test('from 1280px the nav sits in the bar, the sections then Team and Settings, before the email and Sign out', () => {
  setWidth(1280);
  renderBar('/locations/l1/agent');
  const banner = screen.getByRole('banner');
  const nav = within(banner).getByRole('navigation', { name: 'Main' });
  expect(within(nav).getByRole('link', { name: 'TownwiseAI' }).getAttribute('aria-current')).toBe('page');
  const email = within(banner).getByText('a@example.com');
  expect(nav.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(parentOf(nav).contains(email)).toBe(true);
  expect(style(nav).flexGrow).toBe('1');
});

test('without a location the bar keeps its 900px wrap: Team and Settings sit in the bar', () => {
  setWidth(900);
  renderLinked(<TopBar kind="client" email="a@example.com" orgName="Test Group" nav={clientNav('org_admin', '/team', null)} onSignOut={() => undefined} />);
  const nav = within(screen.getByRole('banner')).getByRole('navigation', { name: 'Main' });
  expect(style(parentOf(nav)).borderTopWidth).not.toBe('1px');
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Team', 'Settings']);
});

test('the console’s status filters: 44px links in a row, the selected one filled, inside the margins', () => {
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

test('from 641px to 1023px a table keeps a minimum width, so its focusable region scrolls sideways instead of squeezing nine columns', () => {
  setWidth(768);
  renderLinked(<DataTable label="Organizations" columns={COLUMNS} rows={ROWS} />);
  const region = screen.getByRole('region', { name: 'Organizations' });
  expect(region.getAttribute('tabindex')).toBe('0');
  expect(style(region).overflowX).toBe('auto');
  const content = region.firstElementChild as HTMLElement;
  expect(within(content).getByRole('table')).toBeTruthy();
  const minWidth = parseFloat(style(content).minWidth);
  // Nine columns, 9.6 units of flex: wider than the 704px of content at 768px. Each column of flex 1 or more gets at
  // least MIN_FLEX_WIDTH, which fits a 9-character head like “Locations” (Geist Mono's 0.6em at 12px, plus the
  // cell's 8px and 16px of padding) on one line; a column of flex below 1 gets less and may wrap it.
  expect(minWidth).toBe(Math.ceil(9.6 * MIN_FLEX_WIDTH));
  expect(minWidth).toBeGreaterThan(768 - 2 * 32);
  expect(COLUMNS.find((column) => column.label === 'Locations')?.flex ?? 1).toBeGreaterThanOrEqual(1);
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

test('a link at the end of a message (“Leave {org}.”) is a 44px tap target that leaves its line where it was', () => {
  renderLinked(<Notice text="You joined Test Group. Not your team?" link={{ label: 'Leave Test Group', href: '/other' }} />);
  const link = screen.getByRole('link', { name: 'Leave Test Group' });
  // 20px of text and 13px above and below; an inline box's padding takes no room in the line.
  expect(style(link).paddingTop).toBe('13px');
  expect(style(link).paddingBottom).toBe('13px');
  expect(style(link).display).toBe('inline');
});

test('the compact By month table on a phone is a table, so each value is read with its column head', () => {
  render(<MonthsTable locationId="l1" months={[{ month: '2026-02', dayCount: 28, guests: 1204, netSalesCents: 3_900_000 }]} />);
  const table = within(screen.getByRole('region', { name: 'Sales by month' })).getByRole('table');
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Month', 'Days', 'Guests', 'Net sales']);
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(2);
  expect(within(nth(rows, 1)).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Feb 2026', '28', '1,204', '$39,000']);
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
  // The shown choice is the combobox's first child; it carries the ellipsis.
  const shown = screen.getByRole('combobox', { name: 'Location' }).firstElementChild;
  if (!(shown instanceof HTMLElement)) throw new Error('the select shows no choice');
  expect(shown.textContent).toContain('The Old Mill Tavern');
  expect(shown.style.textOverflow).toBe('ellipsis');
  expect(shown.style.whiteSpace).toBe('nowrap');
  expect(shown.style.overflow).toBe('hidden');
});

test('the portal’s stylesheet sets grayscale antialiasing on its root, as the boards do, and adds no script', () => {
  const scripts = document.querySelectorAll('script').length;
  render(<PortalStyles />);
  const css = [...document.querySelectorAll('style')].map((element) => element.textContent).find((text) => text.includes('#tw-portal'));
  expect(css).toContain('#tw-portal{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}');
  expect(document.querySelectorAll('script')).toHaveLength(scripts);
});
