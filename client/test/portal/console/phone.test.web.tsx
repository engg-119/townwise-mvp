import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import { formatTime } from '../../../src/portal/format';
import { STAFF_EMAIL, VERIFIED_UNTIL } from '../../helpers/portal';
import {
  adminRequest, consoleApi, member, orgDetail, orgRow, person, renderAt, REQUESTER_EMAIL, setWidth, type ConsoleApi,
} from './helpers';

// The staff console on phones and in its tables (spec 15.4, 15.7): the top bar's height, tap targets, the
// selected-row idiom and the View as dialog's title.

afterEach(() => {
  cleanup();
  setWidth(1280);
});

const TAVERN = adminRequest();
const PUB = adminRequest({ id: 'r2', orgName: 'Sample Campus Pub' });

function pending(api: ConsoleApi): void {
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: [TAVERN, PUB], pendingCount: 2 });
}

function style(element: Element): CSSStyleDeclaration {
  return window.getComputedStyle(element);
}

test('at 320px the console bar is one band (wordmark, kind tag, the verified time under them, Sign out) above the nav', async () => {
  setWidth(320);
  const api = consoleApi();
  pending(api);
  renderAt('/admin', api);
  await screen.findByRole('heading', { level: 1, name: 'Requests' });
  const bar = screen.getByRole('banner');
  const bands = [...(bar.firstElementChild?.children ?? [])] as HTMLElement[];
  expect(bands).toHaveLength(2);
  const [first, second] = bands as [HTMLElement, HTMLElement];
  const wordmark = within(first).getByRole('link', { name: 'Townwise' });
  const tag = within(first).getByText('Staff console');
  // The kind tag keeps the bar's normal 16px gap from the wordmark.
  const identity = wordmark.parentElement;
  expect(identity?.contains(tag)).toBe(true);
  expect(identity === null ? '' : style(identity).columnGap).toBe('16px');
  expect(within(first).getByText(`Verified until ${formatTime(VERIFIED_UNTIL)}`)).toBeTruthy();
  expect(within(first).getByRole('button', { name: 'Sign out' })).toBeTruthy();
  // The email hides at 640px and below; the nav keeps its own band.
  expect(screen.queryByText(STAFF_EMAIL)).toBeNull();
  expect(within(second).getByRole('navigation', { name: 'Main' })).toBeTruthy();
});

test.each([320, 1280])('at %ipx the kind tag sits centered beside the wordmark, not level with its top', async (width) => {
  setWidth(width);
  const api = consoleApi();
  pending(api);
  renderAt('/admin', api);
  await screen.findByRole('heading', { level: 1, name: 'Requests' });
  const identity = within(screen.getByRole('banner')).getByRole('link', { name: 'Townwise' }).parentElement;
  if (identity === null) throw new Error('no identity row');
  expect(style(identity).alignItems).toBe('center');
  // StatusTag sets align-self: flex-start for list rows, so the row's item that holds it must center itself.
  const item = [...identity.children].find((child) => child.contains(within(identity).getByText('Staff console')));
  if (item === undefined) throw new Error('no kind tag in the identity row');
  expect(style(item).alignSelf).toBe('center');
});

test('only the selected row’s name has the mint square, so the other names start flush with the column', async () => {
  const api = consoleApi();
  pending(api);
  renderAt('/admin', api);
  const table = await screen.findByRole('region', { name: 'Pending requests' });
  const selected = within(table).getByRole('link', { name: 'Sample Mountain Tavern' });
  const other = within(table).getByRole('link', { name: 'Sample Campus Pub' });
  expect(selected.getAttribute('aria-current')).toBe('true');
  expect(selected.children).toHaveLength(2);
  expect(other.children).toHaveLength(1);
  expect(other.firstElementChild?.textContent).toBe('Sample Campus Pub');
});

test('at 1440px the Approved table fills its column with no forced minimum width, so it does not scroll sideways', async () => {
  setWidth(1440);
  const api = consoleApi();
  const approved = adminRequest({ status: 'approved', decidedAt: '2026-10-04T15:00:00.000Z', decidedBy: { email: STAFF_EMAIL }, orgId: 'o9' });
  api.routes['GET /api/admin/requests?status=approved'] = () => ({ requests: [approved], pendingCount: 0 });
  renderAt('/admin?status=approved', api);
  const region = await screen.findByRole('region', { name: 'Approved requests' });
  // Seven columns, 8.0 units of flex: a 736px minimum, wider than the Split column's 735px at 1440.
  expect(within(region).getAllByRole('columnheader')).toHaveLength(7);
  const content = region.firstElementChild as HTMLElement;
  expect(within(content).getByRole('table')).toBeTruthy();
  expect(style(content).minWidth).toBe('0px');
  expect(style(content).width).toBe('100%');
});

// A 35-character address: 252px of 12px mono, plus the cell's 8px and 16px of padding.
const LONG_EMAIL = ['dana.whitfield', 'birchwoodbistro.test'].join('@');
const LONG_EMAIL_WIDTH = LONG_EMAIL.length * 0.6 * 12 + 8 + 16;

/** The width the Email column gets at the least, from its share of the flex and the table's minimum width. */
function emailColumnFloor(region: HTMLElement): number {
  const content = region.firstElementChild as HTMLElement;
  const heads = within(region).getAllByRole('columnheader');
  const flex = heads.map((head) => parseFloat(style(head).flexGrow));
  const email = heads.findIndex((head) => head.textContent === 'Email');
  return (flex[email] ?? 0) / flex.reduce((sum, value) => sum + value, 0) * parseFloat(style(content).minWidth);
}

test.each([
  ['People', '/admin/people', 'Everyone'],
  ['an organization’s Team', '/admin/orgs/o1', 'Team'],
])('at 768px %s holds a 35-character email on one line, scrolling sideways if it must', async (_page, path, label) => {
  setWidth(768);
  expect(LONG_EMAIL).toHaveLength(35);
  const api = consoleApi();
  api.routes['GET /api/admin/people'] = () => ({ people: [person(LONG_EMAIL, 'pending', { userId: 'u3' })], truncated: false });
  api.routes['GET /api/admin/orgs/o1'] = () => orgDetail({ members: [member('m1', LONG_EMAIL, { role: 'org_admin' })] });
  // U13B: the Forecasts section's read.
  api.routes['GET /api/admin/orgs/o1/forecast-runs'] = () => ({ runs: [] });
  renderAt(path, api);
  const region = await screen.findByRole('region', { name: label });
  expect(within(region).getByText(LONG_EMAIL)).toBeTruthy();
  expect(emailColumnFloor(region)).toBeGreaterThanOrEqual(LONG_EMAIL_WIDTH);
});

test('at 375px an organization’s name in a table is a 44px tap target, from padding rather than a 44px line height', async () => {
  setWidth(375);
  const api = consoleApi();
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: [orgRow('o1', 'Juniper Lane Hospitality Group')] });
  renderAt('/admin/orgs', api);
  const table = await screen.findByRole('region', { name: 'Organizations' });
  const link = within(table).getByRole('link', { name: 'Juniper Lane Hospitality Group' });
  expect(style(link).minHeight).toBe('44px');
  expect(style(link).paddingTop).toBe('14px');
  expect(style(link).paddingBottom).toBe('14px');
});

test('at 320px the View as dialog sets the email in mono 14px, so it takes its own line whole instead of breaking mid-word', async () => {
  setWidth(320);
  const api = consoleApi();
  pending(api);
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: `View as ${REQUESTER_EMAIL}` }));
  const dialog = screen.getByRole('dialog', { name: `View Townwise as ${REQUESTER_EMAIL}` });
  const title = within(dialog).getByRole('heading', { name: `View Townwise as ${REQUESTER_EMAIL}` });
  const email = within(title).getByText(REQUESTER_EMAIL);
  expect(email).not.toBe(title);
  expect(style(email).fontFamily).toContain('Geist Mono');
  const size = parseFloat(style(email).fontSize);
  expect(size).toBe(14);
  // A 320px screen leaves the dialog 254px of text (16px backdrop and 16px dialog padding a side, 1px borders). At
  // Geist Mono's 0.6em advance, 30 characters fit (“maya.okafor@juniperlane.test” has 28).
  expect(30 * 0.6 * size).toBeLessThanOrEqual(320 - 2 * 16 - 2 * 16 - 2);
});
