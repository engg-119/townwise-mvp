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
import { DataTable, MIN_FLEX_WIDTH, RowLink, type Column } from '../../src/portal/ui/DataTable';
import { Notice } from '../../src/portal/ui/feedback';
import { Select } from '../../src/portal/ui/Select';
import { theme } from '../../src/theme';

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

// On web theme.color is var(--tw-<token>), which jsdom leaves unresolved, so a computed color names its token.
const RAISED = theme.color.raised;
const LINE = theme.color.line;
const WHITE = theme.color.white;
const TEXT2 = theme.color.text2;
const PANEL = theme.color.panel;

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
    'Home', 'Calendar', 'Orders', 'Analytics', 'TownwiseAI', 'Team', 'Settings',
  ]);
  // Notes, Rules, Town and Your data sit under More (D38), right after TownwiseAI; More is white while it holds the
  // current page.
  const more = within(nav).getByRole('button', { name: 'More' });
  expect(within(nav).getByRole('link', { name: 'TownwiseAI' }).compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(style(within(more).getByText('More')).color).toBe(WHITE);
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  // On a phone its links take a row under the bar, outside the scroller, which would clip a dropdown.
  expect(more.getAttribute('aria-expanded')).toBe('true');
  const row = screen.getByRole('navigation', { name: 'More' });
  expect(region.contains(row)).toBe(false);
  expect(row.id).toBe(more.getAttribute('aria-controls'));
  // The row is in the flow, so the bar is never lifted for it.
  expect(style(screen.getByRole('banner')).zIndex).not.toBe('1');
  expect(style(row).borderTopWidth).toBe('1px');
  expect(within(row).getAllByRole('link').map((link) => link.textContent)).toEqual(['Notes', 'Rules', 'Town', 'Your data']);
  const notes = within(row).getByRole('link', { name: 'Notes' });
  expect(notes.getAttribute('aria-current')).toBe('page');
  expect(style(notes).minHeight).toBe('44px');
  expect(within(row).getByRole('link', { name: 'Town' }).getAttribute('aria-current')).toBeNull();
  // In the flow it covers nothing, so a press or focus elsewhere leaves it open; Tab reaches it after Settings.
  fireEvent.pointerDown(document.body);
  act(() => { within(nav).getByRole('link', { name: 'Settings' }).focus(); });
  expect(screen.getByRole('navigation', { name: 'More' })).toBeTruthy();
  // Escape from one of its links closes it and hands focus back to More.
  act(() => { notes.focus(); });
  fireEvent.keyDown(notes, { key: 'Escape' });
  expect(screen.queryByRole('navigation', { name: 'More' })).toBeNull();
  expect(document.activeElement).toBe(more);
  expect(more.getAttribute('aria-expanded')).toBe('false');
});

test('More draws in the nav’s colors when nothing under it is current, and a press toggles it', () => {
  renderBar('/locations/l1/agent');
  const more = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'More' });
  expect(style(within(more).getByText('More')).color).toBe(TEXT2);
  fireEvent.click(more);
  expect(style(within(more).getByText('More')).color).toBe(WHITE);
  fireEvent.click(more);
  expect(screen.queryByRole('navigation', { name: 'More' })).toBeNull();
  expect(style(within(more).getByText('More')).color).toBe(TEXT2);
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
  // More drops its links down inside the nav, as from 1280px.
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }));
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
    'Home', 'Calendar', 'Orders', 'Analytics', 'TownwiseAI', 'Notes', 'Rules', 'Town', 'Your data', 'Team', 'Settings',
  ]);
  expect(screen.queryByRole('navigation', { name: 'More' })).toBeNull();
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
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
    'Home', 'Calendar', 'Orders', 'Analytics', 'TownwiseAI', 'Team', 'Settings',
  ]);
  // The links sit `space-5` (20px) apart, not `space-6`, so at 1280px the organization name and the email keep
  // their room (D38); Team and Settings follow suit.
  expect(style(nav).columnGap).toBe('20px');
  expect(style(parentOf(within(nav).getByRole('link', { name: 'Team' }))).columnGap).toBe('20px');
});

test('from 641px More is a dropdown: a square panel box over the page, inside the nav, that closes on Escape, a press or focus outside', () => {
  setWidth(1280);
  renderBar('/locations/l1/sales/upload');
  const banner = screen.getByRole('banner');
  const nav = within(banner).getByRole('navigation', { name: 'Main' });
  const more = within(nav).getByRole('button', { name: 'More' });
  // Closed, More names no container, and the bar stays level with the page, so a layer drawn in main (TownwiseAI's
  // file drop) still covers it.
  expect(more.hasAttribute('aria-controls')).toBe(false);
  expect(style(banner).zIndex).not.toBe('1');
  // Upload lives under Your data, so More holds the current page.
  expect(style(within(more).getByText('More')).color).toBe(WHITE);
  fireEvent.click(more);
  // Open, the bar is lifted over the page, so the box, which hangs below it, paints over main.
  expect(style(banner).zIndex).toBe('1');
  const box = document.getElementById(more.getAttribute('aria-controls') ?? '');
  if (box === null) throw new Error('no dropdown');
  expect(nav.contains(box)).toBe(true);
  expect(style(box).position).toBe('absolute');
  expect(style(box).top).toBe('100%');
  expect(style(box).backgroundColor).toBe(PANEL);
  expect(style(box).borderTopWidth).toBe('1px');
  expect(within(box).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
    ['Notes', '/locations/l1/notes', null], ['Rules', '/locations/l1/rules', null], ['Town', '/locations/l1/town', null],
    ['Your data', '/locations/l1/data', 'true'],
  ]);
  // Its links follow More in the tab order, and a press on More or in the box keeps it open.
  expect(more.compareDocumentPosition(within(box).getByRole('link', { name: 'Notes' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.pointerDown(within(box).getByRole('link', { name: 'Town' }));
  expect(more.getAttribute('aria-expanded')).toBe('true');
  // Escape from a link closes it and hands focus back to More.
  const rules = within(box).getByRole('link', { name: 'Rules' });
  act(() => { rules.focus(); });
  fireEvent.keyDown(rules, { key: 'Escape' });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(more);
  expect(style(banner).zIndex).not.toBe('1');
  // A press outside closes it.
  fireEvent.click(more);
  fireEvent.pointerDown(document.body);
  expect(more.getAttribute('aria-expanded')).toBe('false');
  // So does focus moving on past it, and focus stays where it went.
  fireEvent.click(more);
  const team = within(nav).getByRole('link', { name: 'Team' });
  act(() => { team.focus(); });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(team);
  // An Escape meant for something else leaves it alone.
  fireEvent.click(more);
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(more.getAttribute('aria-expanded')).toBe('true');
});

test('without a location the bar keeps its 900px wrap: Team and Settings sit in the bar', () => {
  setWidth(900);
  renderLinked(<TopBar kind="client" email="a@example.com" orgName="Test Group" nav={clientNav('org_admin', '/team', null)} onSignOut={() => undefined} />);
  const nav = within(screen.getByRole('banner')).getByRole('navigation', { name: 'Main' });
  expect(style(parentOf(nav)).borderTopWidth).not.toBe('1px');
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Team', 'Settings']);
  // Without a location's sections the links keep `space-6`.
  expect(style(nav).columnGap).toBe('24px');
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

test('a row with an href opens it from a press anywhere on it, on phones too, and its RowLink is its one tab stop', async () => {
  const rows = ROWS.map((row, index) => (index === 0 ? { ...row, href: '/other', cells: { ...row.cells, name: <RowLink href="/other" label={row.cells.name} /> } } : row));
  renderLinked(<DataTable label="Organizations" columns={COLUMNS} rows={rows} />);
  const items = within(screen.getByRole('region', { name: 'Organizations' })).getAllByRole('listitem');
  const link = within(nth(items, 0)).getByRole('link', { name: 'Harbor Light Chowder House' });
  expect([link.tagName, link.getAttribute('href'), nth(items, 0).tabIndex]).toEqual(['A', '/other', -1]);
  // A row with no href is as it was: no link.
  expect(within(nth(items, 1)).queryByRole('link')).toBeNull();
  fireEvent.focus(link);
  expect(style(nth(items, 0)).backgroundColor).toBe(RAISED);
  await act(async () => {
    fireEvent.click(within(nth(items, 0)).getByText('445'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  expect(window.location.pathname).toBe('/other');
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
