import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import { formatTime } from '../../../src/portal/format';
import { STAFF_EMAIL, VERIFIED_UNTIL } from '../../helpers/portal';
import { adminRequest, consoleApi, orgRow, renderAt, REQUESTER_EMAIL, setWidth, type ConsoleApi } from './helpers';

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
  expect(within(first).getByRole('link', { name: 'Townwise' })).toBeTruthy();
  expect(within(first).getByText('Staff console')).toBeTruthy();
  expect(within(first).getByText(`Verified until ${formatTime(VERIFIED_UNTIL)}`)).toBeTruthy();
  expect(within(first).getByRole('button', { name: 'Sign out' })).toBeTruthy();
  // The email hides at 640px and below; the nav keeps its own band.
  expect(screen.queryByText(STAFF_EMAIL)).toBeNull();
  expect(within(second).getByRole('navigation', { name: 'Main' })).toBeTruthy();
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
