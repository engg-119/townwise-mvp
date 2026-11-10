import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { formatTime } from '../../../src/portal/format';
import { deferred, offline, refusal } from '../../helpers/portal';
import { auditEvent, CHEF_EMAIL, consoleApi, emailOf, MANAGER_EMAIL, orgRow, renderAt, type ConsoleApi } from './helpers';
import { choicesOf, choose, shownChoice } from '../../helpers/select';

// P23 Audit log: filters, Load more, and what each row shows. docs/portal/spec.md 16.4, Section 9.

afterEach(() => {
  cleanup();
});

const STAFF = emailOf('staff');
const EXPIRES = '2026-10-10T15:30:00.000Z';

const EVENTS = [
  auditEvent('e1', {
    actorEmail: STAFF, actorRole: 'superadmin', viewAs: { targetEmail: MANAGER_EMAIL }, action: 'view_as.ended', summary: 'Ended view-as',
    details: { endReason: 'ended' },
  }),
  auditEvent('e2', {
    actorEmail: STAFF, actorRole: 'superadmin', action: 'view_as.started', summary: `Viewed as ${MANAGER_EMAIL}`,
    details: { targetUserId: 'u2', targetEmail: MANAGER_EMAIL, reason: 'Helping with a question.', expiresAt: EXPIRES },
  }),
  auditEvent('e3', {
    actorEmail: MANAGER_EMAIL, actorRole: 'member', action: 'note.created', summary: 'Added a note (closure), 2026-12-24 to 2026-12-26',
    // An unexpected key never reaches the screen: details read only each action's allowlisted keys.
    details: { locationId: 'l1', kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', detail: 'Family emergency at the Smiths' },
  }),
  auditEvent('e4', {
    action: 'sales.uploaded', summary: 'Uploaded 30 days of sales data, 2026-01-01 to 2026-01-30',
    details: { locationId: 'l1', dayCount: 30, inserted: 20, replaced: 10, firstDate: '2026-01-01', lastDate: '2026-01-30', netSalesCents: 98765400 },
  }),
  auditEvent('e5', {
    actorEmail: emailOf('gm', 'example.org'), actorRole: 'user', orgId: null, orgName: null, action: 'access_request.created',
    summary: 'Requested access for Sample Mountain Tavern in Stowe', details: { orgName: 'Sample Mountain Tavern', townId: 'stowe-vt', townName: 'Stowe' },
  }),
  auditEvent('e6', { actorEmail: STAFF, actorRole: 'superadmin', orgId: 'o7', orgName: null, action: 'org.deleted', summary: 'Deleted the organization', details: {} }),
];

function serveOrgs(api: ConsoleApi): void {
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: [orgRow('o1', 'Sample Restaurant Group'), orgRow('o2', 'Sample Harbor Kitchen')] });
}

function cells(region: HTMLElement, eventIndex: number): string[] {
  const row = within(region).getAllByRole('row')[eventIndex + 1];
  if (row === undefined) throw new Error('no such row');
  return within(row).getAllByRole('cell').map((cell) => cell.textContent);
}

test('newest first: when, who with role and view-as, the server’s summary, the organization, and details', async () => {
  const api = consoleApi();
  serveOrgs(api);
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS, nextBefore: null });
  renderAt('/admin/audit', api);
  const table = await screen.findByRole('region', { name: 'Events' });
  expect(screen.getByText('Every recorded action, newest first. Guest counts, sales figures, note text and request notes are never recorded here.')).toBeTruthy();
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['When', 'Who', 'Action', 'Organization', 'Details']);
  const when = `Oct 10, 2026, ${formatTime('2026-10-10T15:00:00.000Z')}`;
  expect(cells(table, 0)).toEqual([when, `${STAFF}Townwise staff, viewing as ${MANAGER_EMAIL}`, 'Ended view-as', 'Sample Restaurant Group', 'Ended by staff']);
  expect(cells(table, 1)[4]).toBe(`Reason: “Helping with a question.” Until ${formatTime(EXPIRES)}.`);
  expect(cells(table, 2)[1]).toBe(`${MANAGER_EMAIL}Member`);
  expect(cells(table, 2)[4]).toBe('Closure, Dec 24, 2026 to Dec 26, 2026');
  expect(cells(table, 3)[4]).toBe('20 new, 10 replaced, Jan 1, 2026 to Jan 30, 2026');
  expect(cells(table, 4).slice(1)).toEqual(['gm@example.orgNo organization', 'Requested access for Sample Mountain Tavern in Stowe', 'None', 'Town: Stowe']);
  expect(cells(table, 5)[3]).toBe('deleted organization');
  const text = document.body.textContent;
  for (const leak of ['Smiths', 'emergency', '98765400', '987,654']) expect(text).not.toContain(leak);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

test('Load more pages with before, under the rows already shown', async () => {
  const api = consoleApi();
  serveOrgs(api);
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS.slice(0, 2), nextBefore: '2026-10-09T15:00:00.000Z' });
  const second = deferred<unknown>();
  api.routes['GET /api/admin/audit?before=2026-10-09T15%3A00%3A00.000Z'] = () => second.promise;
  renderAt('/admin/audit', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Loading the audit log')).toBeTruthy();
  second.resolve({ events: [auditEvent('e9', { summary: `Added ${CHEF_EMAIL} as member` })], nextBefore: null });
  expect(await screen.findByText(`Added ${CHEF_EMAIL} as member`)).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Events' })).getAllByRole('row')).toHaveLength(4);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

test('filters: organization and action go to the server; an actor email is looked up first, for its user id', async () => {
  const api = consoleApi();
  serveOrgs(api);
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS, nextBefore: null });
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(MANAGER_EMAIL)}`] = () => ({
    person: { userId: 'u2', email: MANAGER_EMAIL, kind: 'member', org: null, since: null, staffTwoStep: null },
  });
  api.routes['GET /api/admin/audit?orgId=o1&actorUserId=u2&action=note.created'] = () => ({ events: [EVENTS[2]], nextBefore: null });
  renderAt('/admin/audit', api);
  await screen.findByRole('region', { name: 'Events' });
  const org = screen.getByRole('combobox', { name: 'Organization' });
  await waitFor(() => { expect(choicesOf(org)).toEqual(['All organizations', 'Sample Restaurant Group', 'Sample Harbor Kitchen']); });
  choose(org, 'Sample Restaurant Group');
  fireEvent.change(screen.getByRole('textbox', { name: 'Actor email' }), { target: { value: ` ${MANAGER_EMAIL} ` } });
  const action = screen.getByRole('combobox', { name: 'Action' });
  expect(choicesOf(action).slice(0, 3)).toEqual(['All actions', 'Request sent', 'Request approved']);
  choose(action, 'Note added');
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() => { expect(within(screen.getByRole('region', { name: 'Events' })).getAllByRole('row')).toHaveLength(2); });
  // Filtered to one organization, the Organization column goes.
  expect(within(screen.getByRole('region', { name: 'Events' })).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['When', 'Who', 'Action', 'Details']);
  // The actor's email went only in the lookup's q, never in the audit query.
  expect(api.calls.filter((call) => call.path.startsWith('/api/admin/audit')).every((call) => !call.path.includes('example'))).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => { expect(within(screen.getByRole('region', { name: 'Events' })).getAllByRole('row')).toHaveLength(EVENTS.length + 1); });
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Actor email' }).value).toBe('');
});

test('an actor email no one signed in with finds no events', async () => {
  const api = consoleApi();
  serveOrgs(api);
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS, nextBefore: null });
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(emailOf('nobody'))}`] = () => ({ person: null });
  renderAt('/admin/audit', api);
  await screen.findByRole('region', { name: 'Events' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Actor email' }), { target: { value: emailOf('nobody') } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  expect(await screen.findByText('No one with that email has signed in.')).toBeTruthy();
});

test('opened from an organization’s page, filtered to it; empty says nothing recorded yet, with Clear filters', async () => {
  const api = consoleApi();
  serveOrgs(api);
  api.routes['GET /api/admin/audit?orgId=o2'] = () => ({ events: [], nextBefore: null });
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS, nextBefore: null });
  renderAt('/admin/audit?orgId=o2', api);
  expect(await screen.findByText('Nothing recorded yet.')).toBeTruthy();
  expect(shownChoice(screen.getByRole('combobox', { name: 'Organization' }))).toBe('Sample Harbor Kitchen');
  const clear = screen.getAllByRole('button', { name: 'Clear filters' });
  expect(clear).toHaveLength(2);
  const inEmpty = clear[1];
  if (inEmpty === undefined) throw new Error('no Clear filters in the empty state');
  fireEvent.click(inEmpty);
  expect(await screen.findByRole('region', { name: 'Events' })).toBeTruthy();
});

test('an actor that isn’t an email address says so at the field and sends nothing; a 400 reads the same', async () => {
  const api = consoleApi();
  serveOrgs(api);
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS, nextBefore: null });
  const odd = emailOf('odd');
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(odd)}`] = () => refusal(400, 'invalid_request');
  renderAt('/admin/audit', api);
  await screen.findByRole('region', { name: 'Events' });
  const field = screen.getByRole('textbox', { name: 'Actor email' });
  fireEvent.change(field, { target: { value: 'bob' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  expect(screen.getByText('Enter an email address.')).toBeTruthy();
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(api.calls.filter((call) => call.path.includes('/lookup'))).toEqual([]);
  expect(screen.getByRole('region', { name: 'Events' })).toBeTruthy();
  // The server refuses an address the page let through: the same words, and no Try again that sends it again.
  fireEvent.change(field, { target: { value: odd } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() => { expect(api.calls.filter((call) => call.path.includes('/lookup'))).toHaveLength(1); });
  expect(await screen.findByText('Enter an email address.')).toBeTruthy();
  expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('loading, then the network copy with Try again', async () => {
  const api = consoleApi();
  serveOrgs(api);
  const first = deferred<unknown>();
  let answer: unknown = first.promise;
  api.routes['GET /api/admin/audit'] = () => answer;
  renderAt('/admin/audit', api);
  expect(await screen.findByText('Loading the audit log')).toBeTruthy();
  first.resolve(offline());
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  answer = { events: EVENTS, nextBefore: null };
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('region', { name: 'Events' })).toBeTruthy();
});

test('when the organizations to filter by don’t load, the filters say so, with Try again', async () => {
  const api = consoleApi();
  let fail = true;
  api.routes['GET /api/admin/orgs'] = () => (fail ? offline() : { orgs: [orgRow('o1', 'Sample Restaurant Group')] });
  api.routes['GET /api/admin/audit'] = () => ({ events: EVENTS, nextBefore: null });
  renderAt('/admin/audit', api);
  await screen.findByRole('region', { name: 'Events' });
  const filters = screen.getByRole('region', { name: 'Filters' });
  expect(await within(filters).findByText('The organizations to filter by didn’t load. Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fail = false;
  fireEvent.click(within(filters).getByRole('button', { name: 'Try again' }));
  const options = (): string[] => choicesOf(within(filters).getByRole('combobox', { name: 'Organization' }));
  await waitFor(() => { expect(options()).toEqual(['All organizations', 'Sample Restaurant Group']); });
  expect(within(filters).queryByRole('button', { name: 'Try again' })).toBeNull();
  // The log itself loaded once; only the filter's list was read again.
  expect(api.calls.filter((call) => call.path === '/api/admin/audit')).toHaveLength(1);
});
