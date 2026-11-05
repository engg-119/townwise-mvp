import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { ACCESS, offline, refusal, staffMe, viewAsMe, writes } from '../../helpers/portal';
import { adminRequest, consoleApi, emailOf, renderAt, REQUESTER_EMAIL, type ConsoleApi } from './helpers';

// P19 Requests, with Approve (C3), Reject (C4) and View as (C1): docs/portal/spec.md 16.4, F3, F4, F8.

afterEach(() => {
  cleanup();
});

const OLD_EMAIL = emailOf('old', 'example.net');
const TAVERN = adminRequest();
const PUB = adminRequest({
  id: 'r2', orgName: 'Sample Campus Pub', contactName: 'Sam', contactRole: 'General manager', note: null,
  town: { townId: 'amherst-ma', name: 'Amherst', state: 'MA' }, createdAt: '2026-10-03T15:00:00.000Z',
  requester: { userId: 'u8', email: emailOf('owner', 'example.net') }, emailAtRequest: OLD_EMAIL, requesterHasOrg: true,
});

function list(api: ConsoleApi, status: string, requests: unknown[], pendingCount = 2): void {
  api.routes[`GET /api/admin/requests?status=${status}`] = () => ({ requests, pendingCount });
}

function rowNames(region: HTMLElement): string[] {
  return within(region).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
}

function gets(api: ConsoleApi, path: string): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === path).length;
}

test('pending: the queue as the server sorts it, the tabs with the count, and the first request’s detail', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN, PUB]);
  renderAt('/admin', api);
  const table = await screen.findByRole('region', { name: 'Pending requests' });
  expect(rowNames(table)).toEqual(['Sample Mountain Tavern', 'Sample Campus Pub']);
  const heads = within(table).getAllByRole('columnheader').map((head) => head.textContent);
  expect(heads).toEqual(['Organization', 'Contact', 'Email', 'Town', 'Locations', 'Sent']);
  expect(within(table).getByText('Pat, Owner')).toBeTruthy();
  expect(within(table).getByText('Stowe, VT')).toBeTruthy();

  const tabs = screen.getByRole('navigation', { name: 'Requests by status' });
  expect(within(tabs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Pending 2', 'Approved', 'Rejected', 'Withdrawn']);
  expect(within(tabs).getByRole('link', { name: 'Pending 2' }).getAttribute('aria-current')).toBe('page');

  const detail = screen.getByRole('region', { name: 'Request: Sample Mountain Tavern' });
  expect(within(detail).getByText('Two bars and a cafe.')).toBeTruthy();
  expect(within(detail).getByText(REQUESTER_EMAIL)).toBeTruthy();
  expect(within(detail).queryByText('This person already belongs to an organization.')).toBeNull();
  expect(within(table).getByRole('link', { name: 'Sample Mountain Tavern' }).getAttribute('aria-current')).toBe('true');

  fireEvent.click(within(table).getByRole('link', { name: 'Sample Campus Pub' }));
  const second = await screen.findByRole('region', { name: 'Request: Sample Campus Pub' });
  expect(window.location.search).toBe('?request=r2');
  expect(within(second).getByText('This person already belongs to an organization.')).toBeTruthy();
  expect(within(second).getByText(`Requested as ${OLD_EMAIL}`)).toBeTruthy();
  expect(within(second).getByText('None')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Pending requests' })).getByRole('link', { name: 'Sample Campus Pub' }).getAttribute('aria-current')).toBe('true');
});

test('empty tabs say what is missing; the tabs filter by status, newest first, with Decided and By', async () => {
  const api = consoleApi();
  list(api, 'pending', [], 0);
  list(api, 'rejected', []);
  const approved = adminRequest({
    status: 'approved', decidedAt: '2026-10-04T15:00:00.000Z', decidedBy: { email: emailOf('ops') }, orgId: 'o9', requesterHasOrg: true,
  });
  list(api, 'approved', [approved]);
  renderAt('/admin', api);
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'See approved requests' }));
  const table = await screen.findByRole('region', { name: 'Approved requests' });
  expect(window.location.search).toBe('?status=approved');
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
    'Organization', 'Contact', 'Email', 'Town', 'Locations', 'Decided', 'By',
  ]);
  const detail = screen.getByRole('region', { name: 'Request: Sample Mountain Tavern' });
  // Decided requests have no Approve or Reject, and no has-an-organization warning.
  expect(within(detail).queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(within(detail).queryByText('This person already belongs to an organization.')).toBeNull();
  expect(within(detail).getByRole('link', { name: 'Open the organization' }).getAttribute('href')).toBe('/admin/orgs/o9');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Requests by status' })).getByRole('link', { name: 'Rejected' }));
  expect(await screen.findByText('No rejected requests.')).toBeTruthy();
});

test('loading, then the network copy with Try again', async () => {
  const api = consoleApi();
  let fail = true;
  api.routes['GET /api/admin/requests?status=pending'] = () => (fail ? offline() : { requests: [TAVERN], pendingCount: 1 });
  renderAt('/admin', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('Loading requests')).toBeTruthy();
  expect(await screen.findByRole('region', { name: 'Pending requests' })).toBeTruthy();
});

test('Approve (C3): prefilled names, the town, field checks, then the notice and the request leaves Pending', async () => {
  const api = consoleApi();
  let pending: unknown[] = [TAVERN];
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: pending, pendingCount: pending.length });
  api.routes['POST /api/admin/requests/r1/approve'] = () => {
    pending = [];
    return { org: { id: 'o9', name: 'Mountain Tavern' }, request: { ...TAVERN, status: 'approved', orgId: 'o9' } };
  };
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  const dialog = screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' });
  const orgName = within(dialog).getByRole('textbox', { name: 'Organization name' });
  const locationName = within(dialog).getByRole('textbox', { name: 'First location name' });
  expect((orgName as HTMLInputElement).value).toBe('Sample Mountain Tavern');
  expect((locationName as HTMLInputElement).value).toBe('Sample Mountain Tavern');
  expect(within(dialog).getByText('Stowe, VT')).toBeTruthy();
  expect(within(dialog).getByText(`This creates the organization and its first location in Stowe, VT, and makes ${REQUESTER_EMAIL} its admin. They get access the next time they open Townwise. We don’t send email yet.`)).toBeTruthy();

  fireEvent.change(orgName, { target: { value: 'M' } });
  fireEvent.change(locationName, { target: { value: '  ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(within(dialog).getByText('Enter the organization’s name, 2 to 120 characters.')).toBeTruthy();
  expect(within(dialog).getByText('Enter the first location’s name, up to 80 characters.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  fireEvent.change(orgName, { target: { value: ' Mountain Tavern ' } });
  fireEvent.change(locationName, { target: { value: 'Main Street' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Mountain Tavern', locationName: 'Main Street' } },
  ]);
  expect(screen.queryByRole('heading', { level: 2, name: /^(Approve|Reject) / })).toBeNull();
  expect(screen.getByText(/^Approved\. Mountain Tavern is set up, and pat@example\.org is its admin\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Mountain Tavern' }).getAttribute('href')).toBe('/admin/orgs/o9');
  expect(within(screen.getByRole('navigation', { name: 'Requests by status' })).getAllByRole('link')[0]?.textContent).toBe('Pending 0');
});

test('Approve refusals: someone else decided it (the list reloads); the requester joined an organization meanwhile', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN]);
  api.routes['POST /api/admin/requests/r1/approve'] = () => refusal(409, 'requester_has_org');
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  let dialog = screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await within(dialog).findByText('This person already belongs to an organization.')).toBeTruthy();

  api.routes['POST /api/admin/requests/r1/approve'] = () => refusal(409, 'request_not_pending');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Someone already decided this request.')).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 2, name: /^(Approve|Reject) / })).toBeNull();
  await screen.findByRole('region', { name: 'Pending requests' });
  expect(gets(api, '/api/admin/requests?status=pending')).toBeGreaterThanOrEqual(3);

  // Cancel closes without a write.
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  dialog = screen.getByRole('dialog', { name: 'Reject Sample Mountain Tavern?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('heading', { level: 2, name: /^(Approve|Reject) / })).toBeNull();
  expect(writes(api)).toHaveLength(2);
});

test('Reject (C4): an optional message, sent only when written; the notice links to the Rejected tab', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN, PUB]);
  api.routes['POST /api/admin/requests/r1/reject'] = () => ({ request: { ...TAVERN, status: 'rejected' } });
  api.routes['POST /api/admin/requests/r2/reject'] = () => ({ request: { ...PUB, status: 'rejected' } });
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  let dialog = screen.getByRole('dialog', { name: 'Reject Sample Mountain Tavern?' });
  const message = within(dialog).getByRole('textbox', { name: 'Message to Pat (optional)' });
  expect(message.getAttribute('maxlength')).toBe('500');
  expect(within(dialog).getByText('Shown on their No access page. Up to 500 characters.')).toBeTruthy();
  fireEvent.change(message, { target: { value: '  We need a website first.  ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
  expect(await screen.findByText(/^Rejected the request for Sample Mountain Tavern\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'See rejected requests' }).getAttribute('href')).toBe('/admin?status=rejected');

  fireEvent.click(within(await screen.findByRole('region', { name: 'Pending requests' })).getByRole('link', { name: 'Sample Campus Pub' }));
  await screen.findByRole('region', { name: 'Request: Sample Campus Pub' });
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  dialog = screen.getByRole('dialog', { name: 'Reject Sample Campus Pub?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
  await waitFor(() => { expect(screen.queryByRole('heading', { level: 2, name: /^(Approve|Reject) / })).toBeNull(); });
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/reject', body: { message: 'We need a website first.' } },
    { method: 'POST', path: '/api/admin/requests/r2/reject', body: {} },
  ]);
});

test('Reject when someone already decided it, and the shared copy for other refusals', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN]);
  api.routes['POST /api/admin/requests/r1/reject'] = () => refusal(503, 'unavailable');
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  const dialog = screen.getByRole('dialog', { name: 'Reject Sample Mountain Tavern?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
  expect(await within(dialog).findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  api.routes['POST /api/admin/requests/r1/reject'] = () => refusal(409, 'request_not_pending');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
  expect(await screen.findByText('Someone already decided this request.')).toBeTruthy();
});

test('View as (C1) from a request: a reason of 5 to 200 characters, then the requester’s Waiting page under the banner', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN]);
  api.routes['POST /api/admin/view-as'] = () => {
    api.me = viewAsMe(ACCESS.pending);
    return api.me;
  };
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: `View as ${REQUESTER_EMAIL}` }));
  const dialog = screen.getByRole('dialog', { name: `View Townwise as ${REQUESTER_EMAIL}` });
  // No organization: the clause about its admins is left out.
  expect(within(dialog).getByText(`You’ll see what ${REQUESTER_EMAIL} sees, read-only, for 30 minutes. This is recorded in the audit log with your reason. It ends early if ${REQUESTER_EMAIL} joins, leaves or changes organization.`)).toBeTruthy();
  const reason = within(dialog).getByRole('textbox', { name: 'Reason' });
  fireEvent.change(reason, { target: { value: 'Hi' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start viewing' }));
  expect(within(dialog).getByText('Enter a reason, 5 to 200 characters.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  fireEvent.change(reason, { target: { value: ' Checking their town. ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start viewing' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/waiting'); });
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as', body: { userId: 'u9', reason: 'Checking their town.' } }]);
  expect(await screen.findByRole('region', { name: 'View-as' })).toBeTruthy();
});

test.each<[string, () => unknown, string]>([
  ['a staff target', () => refusal(400, 'invalid_target'), 'Staff accounts can’t be viewed as.'],
  ['a person who is gone', () => refusal(404, 'not_found'), 'This person no longer exists.'],
  ['too many starts', () => refusal(429, 'rate_limited', 600), 'Too many attempts. Try again in 10 minutes.'],
])('View as refuses %s in its own words', async (_name, answer, copy) => {
  const api = consoleApi();
  list(api, 'pending', [PUB]);
  api.routes['POST /api/admin/view-as'] = answer;
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: /^View as/ }));
  const dialog = screen.getByRole('dialog', { name: /^View Townwise as/ });
  // The requester already has an organization, so its admins will see the view.
  expect(within(dialog).getByText(/with your reason, and their organization’s admins can see it\./)).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), { target: { value: 'Helping with a question.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start viewing' }));
  expect(await within(dialog).findByText(copy)).toBeTruthy();
});

test('while view-as is active, the console answers 409 view_as_active and the shell routes to the target', async () => {
  const api = consoleApi();
  api.routes['GET /api/admin/requests?status=pending'] = () => {
    api.me = viewAsMe(ACCESS.pending);
    return refusal(409, 'view_as_active');
  };
  renderAt('/admin', api);
  await waitFor(() => { expect(window.location.pathname).toBe('/waiting'); });
  expect(await screen.findByRole('region', { name: 'View-as' })).toBeTruthy();
});

test('a staff window that ran out mid-action sends staff to sign in again', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN]);
  api.routes['POST /api/admin/requests/r1/approve'] = () => {
    api.me = staffMe(ACCESS.staffReauth);
    return refusal(403, 'staff_reauth_required');
  };
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).getByRole('button', { name: 'Approve' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/staff/sign-in-again'); });
});

function navCount(): string | null | undefined {
  return within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link')[0]?.textContent;
}

test('the console nav’s Requests count reads again after an approve and after a reject', async () => {
  const api = consoleApi();
  let pending: unknown[] = [TAVERN, PUB];
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: pending, pendingCount: pending.length });
  api.routes['POST /api/admin/requests/r1/approve'] = () => {
    pending = [PUB];
    return { org: { id: 'o9', name: 'Mountain Tavern' }, request: { ...TAVERN, status: 'approved', orgId: 'o9' } };
  };
  api.routes['POST /api/admin/requests/r2/reject'] = () => {
    pending = [];
    return { request: { ...PUB, status: 'rejected' } };
  };
  renderAt('/admin', api);
  await waitFor(() => { expect(navCount()).toBe('Requests 2'); });

  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).getByRole('button', { name: 'Approve' }));
  await waitFor(() => { expect(navCount()).toBe('Requests 1'); });

  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Reject Sample Campus Pub?' })).getByRole('button', { name: 'Reject' }));
  await waitFor(() => { expect(navCount()).toBe('Requests 0'); });
});
