import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { ACCESS, deferred, offline, refusal, STAFF_EMAIL, staffMe, viewAsMe, writes } from '../../helpers/portal';
import { createAuthStore } from '../../../src/auth/store';
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
  expect((locationName as HTMLInputElement).value).toBe('Sample Mountain Tavern, Stowe');
  expect(within(dialog).getByText('Stowe, VT')).toBeTruthy();
  expect(within(dialog).getByText(`This creates the organization and its first location in Stowe, VT, and makes ${REQUESTER_EMAIL} its admin. We email them that they’re in, and they get access the next time they open Townwise.`)).toBeTruthy();

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

const STOWE = { townId: 'stowe-vt', name: 'Stowe', state: 'VT' };
const ONE_LOCATION = 'Shown to them only once they have more than one location.';
const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
const NORWICH = { townId: null, name: 'Norwich', state: 'VT' };
const TWO_PLACES = adminRequest({
  places: [
    { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', kind: 'business', town: HANOVER },
    { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', kind: 'business', town: NORWICH },
  ],
});

async function openApprove(request: unknown): Promise<{ api: ConsoleApi; dialog: HTMLElement }> {
  const api = consoleApi();
  let pending: unknown[] = [request];
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: pending, pendingCount: pending.length });
  api.routes['POST /api/admin/requests/r1/approve'] = () => (pending = [], { org: { id: 'o9', name: 'Sample Mountain Tavern' }, request: { ...TAVERN, status: 'approved', orgId: 'o9' } });
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  return { api, dialog: screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' }) };
}

test('Approve without places starts First location name as “{organization}, {Town}”, with the helper for one location', async () => {
  const { dialog } = await openApprove(adminRequest({ town: NORWICH }));
  const field = within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'First location name' });
  expect(field.value).toBe('Sample Mountain Tavern, Norwich');
  expect(within(dialog).getByText(ONE_LOCATION)).toBeTruthy();
});

test('Approve starts each Location name as “{Google name}, {Town}”, an address’s as “{organization}, {Town}”', async () => {
  const { api, dialog } = await openApprove(adminRequest({
    places: [
      { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', kind: 'business', town: HANOVER },
      { placeId: 'ChIJTestPlace0006', name: '12 South Main Street', kind: 'address', town: NORWICH },
    ],
  }));
  const first = within(within(dialog).getByRole('group', { name: 'Place 1 of 2' }));
  const second = within(within(dialog).getByRole('group', { name: 'Place 2 of 2' }));
  expect(first.getByRole<HTMLInputElement>('textbox', { name: 'Location name' }).value).toBe('Lou’s Restaurant, Hanover');
  expect(second.getByRole<HTMLInputElement>('textbox', { name: 'Location name' }).value).toBe('Sample Mountain Tavern, Norwich');
  // The place's line says which is a street address; with two, no helper.
  expect(first.getByText('Lou’s Restaurant, Hanover, NH')).toBeTruthy();
  expect(second.getByText('12 South Main Street (street address), Norwich, VT')).toBeTruthy();
  expect(within(dialog).queryByText(ONE_LOCATION)).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Sample Mountain Tavern', locationNames: ['Lou’s Restaurant, Hanover', 'Sample Mountain Tavern, Norwich'] } },
  ]);
});

test('Approve (C3) with places: a Location name per place, prefilled, each with its town; the body carries locationNames in order', async () => {
  const { api, dialog } = await openApprove(TWO_PLACES);
  const first = within(within(dialog).getByRole('group', { name: 'Place 1 of 2' }));
  const second = within(within(dialog).getByRole('group', { name: 'Place 2 of 2' }));
  expect(first.getByText('Lou’s Restaurant, Hanover, NH')).toBeTruthy();
  expect(second.getByText('Lou’s Bakery, Norwich, VT')).toBeTruthy();
  expect(first.getByRole<HTMLInputElement>('textbox', { name: 'Location name' }).value).toBe('Lou’s Restaurant, Hanover');
  const other = second.getByRole<HTMLInputElement>('textbox', { name: 'Location name' });
  expect(other.value).toBe('Lou’s Bakery, Norwich');
  expect(within(dialog).queryByRole('textbox', { name: 'First location name' })).toBeNull();
  expect(within(dialog).getByText(`This creates the organization and its 2 locations, and makes ${REQUESTER_EMAIL} its admin. We email them that they’re in, and they get access the next time they open Townwise.`)).toBeTruthy();

  fireEvent.change(other, { target: { value: 'Elm Street' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Sample Mountain Tavern', locationNames: ['Lou’s Restaurant, Hanover', 'Elm Street'] } },
  ]);
});

test('Enter in a place’s Location name approves, as it does in the dialog without places', async () => {
  const { api, dialog } = await openApprove(TWO_PLACES);
  const field = within(within(dialog).getByRole('group', { name: 'Place 2 of 2' })).getByRole('textbox', { name: 'Location name' });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Sample Mountain Tavern', locationNames: ['Lou’s Restaurant, Hanover', 'Lou’s Bakery, Norwich'] } },
  ]);
});

test('Each location needs its own name: two defaults alike (one name in one town), the same ignoring case and spaces, or empty stop the approve', async () => {
  const { api, dialog } = await openApprove(adminRequest({
    places: [
      { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', kind: 'business', town: HANOVER },
      { placeId: 'ChIJTestPlace0003', name: 'Lou’s Restaurant', kind: 'business', town: HANOVER },
    ],
  }));
  const approve = (): void => { fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' })); };
  const second = (): HTMLElement => within(within(dialog).getByRole('group', { name: 'Place 2 of 2' })).getByRole('textbox', { name: 'Location name' });
  const groups = (): HTMLElement[] => [1, 2].map((n) => within(dialog).getByRole('group', { name: `Place ${n} of 2` }));
  approve();
  for (const group of groups()) expect(within(group).getByText('Each location needs its own name.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  fireEvent.change(second(), { target: { value: ' lou’s  restaurant,  hanover ' } });
  approve();
  for (const group of groups()) expect(within(group).getByText('Each location needs its own name.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  fireEvent.change(second(), { target: { value: '' } });
  approve();
  expect(within(within(dialog).getByRole('group', { name: 'Place 2 of 2' })).getByText('Each location needs its own name.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  fireEvent.change(second(), { target: { value: 'Lebanon' } });
  approve();
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Sample Mountain Tavern', locationNames: ['Lou’s Restaurant, Hanover', 'Lebanon'] } },
  ]);
});

test('a legacy place’s Location name starts as “{organization}, {Town}”, with the helper for one location; the text names the request’s town', async () => {
  const { api, dialog } = await openApprove(adminRequest({ places: [{ placeId: 'ChIJTestPlace0009', name: null, kind: 'business', town: STOWE }] }));
  const group = within(within(dialog).getByRole('group', { name: 'Place 1 of 1' }));
  const field = group.getByRole<HTMLInputElement>('textbox', { name: 'Location name' });
  expect(field.value).toBe('Sample Mountain Tavern, Stowe');
  expect(group.getByText(ONE_LOCATION)).toBeTruthy();
  expect(group.getByText('Stowe, VT')).toBeTruthy();
  expect(within(dialog).getByText(`This creates the organization and its first location in Stowe, VT, and makes ${REQUESTER_EMAIL} its admin. We email them that they’re in, and they get access the next time they open Townwise.`)).toBeTruthy();
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(group.getByText('Each location needs its own name.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  fireEvent.change(field, { target: { value: 'Main Street' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Sample Mountain Tavern', locationNames: ['Main Street'] } },
  ]);
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

test('a request link to one the list doesn’t have says so, and selects no other request', async () => {
  const api = consoleApi();
  const other = adminRequest({ id: 'r7', orgName: 'Sample Other Group', status: 'approved', orgId: 'o7' });
  list(api, 'approved', [other]);
  renderAt('/admin?status=approved&request=r1', api);
  const table = await screen.findByRole('region', { name: 'Approved requests' });
  expect(screen.getByText('That request is no longer listed. Choose one from the list.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: /^Request: / })).toBeNull();
  expect(within(table).getByRole('link', { name: 'Sample Other Group' }).getAttribute('aria-current')).toBeNull();
});

test('an approve for a request that is gone (404) closes, says so, and reads the list and the count again', async () => {
  const api = consoleApi();
  let pending: unknown[] = [TAVERN];
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: pending, pendingCount: pending.length });
  api.routes['POST /api/admin/requests/r1/approve'] = () => { pending = []; return refusal(404, 'not_found'); };
  renderAt('/admin', api);
  await waitFor(() => { expect(navCount()).toBe('Requests 1'); });
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('That request is no longer listed.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(await screen.findByText('No requests are waiting.')).toBeTruthy();
  await waitFor(() => { expect(navCount()).toBe('Requests 0'); });
});

test('an approve refused because the requester joined an organization reads the list and the count again', async () => {
  const api = consoleApi();
  let pending: unknown[] = [TAVERN];
  let count = 1;
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: pending, pendingCount: count });
  api.routes['POST /api/admin/requests/r1/approve'] = () => {
    pending = [{ ...TAVERN, requesterHasOrg: true }];
    count = 3;
    return refusal(409, 'requester_has_org');
  };
  renderAt('/admin', api);
  await waitFor(() => { expect(navCount()).toBe('Requests 1'); });
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  const dialog = screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  expect(await within(dialog).findByText('This person already belongs to an organization.')).toBeTruthy();
  await waitFor(() => { expect(navCount()).toBe('Requests 3'); });
  expect(await screen.findByRole('link', { name: 'Pending 3' })).toBeTruthy();
});

test('“Someone already decided this request.” stays on its tab: switching tabs drops it', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN]);
  list(api, 'approved', []);
  api.routes['POST /api/admin/requests/r1/approve'] = () => refusal(409, 'request_not_pending');
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Someone already decided this request.')).toBeTruthy();
  const tabs = screen.getByRole('navigation', { name: 'Requests by status' });
  fireEvent.click(within(tabs).getByRole('link', { name: 'Approved' }));
  expect(await screen.findByText('No approved requests.')).toBeTruthy();
  expect(screen.queryByText('Someone already decided this request.')).toBeNull();
  fireEvent.click(within(tabs).getByRole('link', { name: /^Pending/ }));
  await screen.findByRole('region', { name: 'Pending requests' });
  expect(screen.queryByText('Someone already decided this request.')).toBeNull();
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

test('a staff window that ran out mid-action signs staff out to the ordinary sign-in page', async () => {
  const api = consoleApi();
  const store = createAuthStore({ status: 'signedIn', user: { id: 's1', email: STAFF_EMAIL } });
  const signOut = jest.fn((notice?: string) => {
    store.set(notice === undefined ? { status: 'signedOut' } : { status: 'signedOut', notice });
    return Promise.resolve();
  });
  list(api, 'pending', [TAVERN]);
  api.routes['POST /api/admin/requests/r1/approve'] = () => {
    api.me = staffMe(ACCESS.staffReauth);
    return refusal(403, 'staff_reauth_required');
  };
  renderAt('/admin', api, { signOut, store });
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).getByRole('button', { name: 'Approve' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/sign-in'); });
  expect(signOut).toHaveBeenCalledWith('Staff sessions need a fresh sign-in with your code every 60 minutes.');
  expect(await screen.findByText('Staff sessions need a fresh sign-in with your code every 60 minutes.')).toBeTruthy();
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

test('the nav’s Requests count reads again when the console route changes', async () => {
  const api = consoleApi();
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: [] });
  api.routes['GET /api/admin/people'] = () => ({ people: [], truncated: false });
  renderAt('/admin/orgs', api);
  await waitFor(() => { expect(navCount()).toBe('Requests 2'); });
  // A request arrived meanwhile.
  api.pendingCount = 5;
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'People' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin/people'); });
  await waitFor(() => { expect(navCount()).toBe('Requests 5'); });
});

test('on /admin the nav takes its count from the page’s list read and reads nothing of its own; elsewhere it reads', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN], 3);
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: [] });
  renderAt('/admin', api);
  await waitFor(() => { expect(navCount()).toBe('Requests 3'); });
  expect(gets(api, '/api/admin/requests?status=pending')).toBe(1);
  // Another console page has no list of its own, so the frame reads the count.
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Organizations' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin/orgs'); });
  await waitFor(() => { expect(gets(api, '/api/admin/requests?status=pending')).toBe(2); });
});

test('the nav’s Requests count takes the pending count a Requests list read returns', async () => {
  const api = consoleApi();
  let count = 1;
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: [TAVERN], pendingCount: count });
  api.routes['GET /api/admin/requests?status=approved'] = () => ({ requests: [], pendingCount: count });
  renderAt('/admin', api);
  await waitFor(() => { expect(navCount()).toBe('Requests 1'); });
  // Three requests arrived meanwhile; switching tabs reads the list, and its count, again.
  count = 4;
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Requests by status' })).getByRole('link', { name: 'Approved' }));
  expect(await screen.findByText('No approved requests.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Pending 4' })).toBeTruthy();
  await waitFor(() => { expect(navCount()).toBe('Requests 4'); });
});

function escape(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); });
}

test('while a decision is sent, Cancel and Escape leave its dialog open, so the answer lands in it', async () => {
  const api = consoleApi();
  list(api, 'pending', [TAVERN]);
  const answer = deferred<unknown>();
  api.routes['POST /api/admin/requests/r1/approve'] = () => answer.promise;
  renderAt('/admin', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  const dialog = screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  await waitFor(() => { expect(cancel.getAttribute('aria-disabled')).toBe('true'); });
  fireEvent.click(cancel);
  escape();
  expect(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).toBe(dialog);

  await act(async () => { answer.resolve(refusal(503, 'unavailable')); await answer.promise; });
  expect(await within(dialog).findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  // Answered, Cancel closes it again.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).toBeNull();
  expect(writes(api)).toHaveLength(1);
});

/** Focus is on the element that holds this text, not left on the page body. */
function expectFocusOn(text: RegExp): void {
  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(active?.textContent).toMatch(text);
}

test('a decision takes its opener off the page, so focus moves to the notice; after a 409, to its line', async () => {
  const api = consoleApi();
  let pending: unknown[] = [TAVERN, PUB];
  api.routes['GET /api/admin/requests?status=pending'] = () => ({ requests: pending, pendingCount: pending.length });
  api.routes['POST /api/admin/requests/r1/approve'] = () => {
    pending = [PUB];
    return { org: { id: 'o9', name: 'Mountain Tavern' }, request: { ...TAVERN, status: 'approved', orgId: 'o9' } };
  };
  api.routes['POST /api/admin/requests/r2/reject'] = () => refusal(409, 'request_not_pending');
  renderAt('/admin', api);
  const approve = await screen.findByRole('button', { name: 'Approve' });
  approve.focus();
  fireEvent.click(approve);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Approve Sample Mountain Tavern' })).getByRole('button', { name: 'Approve' }));
  await screen.findByRole('region', { name: 'Request: Sample Campus Pub' });
  expectFocusOn(/^\d+Approved\. Mountain Tavern is set up/);

  const reject = screen.getByRole('button', { name: 'Reject' });
  reject.focus();
  fireEvent.click(reject);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Reject Sample Campus Pub?' })).getByRole('button', { name: 'Reject' }));
  await screen.findByText('Someone already decided this request.');
  await screen.findByRole('region', { name: 'Pending requests' });
  // The newer line, not the approval notice still above it.
  expectFocusOn(/^\d+Someone already decided this request\.$/);

  // A second late decision with the same words is a new line, and takes focus again.
  const again = await screen.findByRole('button', { name: 'Reject' });
  again.focus();
  fireEvent.click(again);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Reject Sample Campus Pub?' })).getByRole('button', { name: 'Reject' }));
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Reject Sample Campus Pub?' })).toBeNull(); });
  await screen.findByRole('region', { name: 'Pending requests' });
  expectFocusOn(/^\d+Someone already decided this request\.$/);
});
