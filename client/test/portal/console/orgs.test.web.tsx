import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { deferred, offline, refusal, writes } from '../../helpers/portal';
import { consoleApi, emailOf, orgDetail, orgRow, renderAt, setWidth } from './helpers';

// P20 Organizations, with New organization (C5): docs/portal/spec.md 16.4, F10.

afterEach(() => {
  cleanup();
  setWidth(1280);
});

const ORGS = [
  orgRow('o1', 'Sample Restaurant Group'),
  orgRow('o2', 'Sample Harbor Kitchen', { status: 'suspended' }),
  orgRow('o3', 'Sample Ski Bar', { adminCount: 0, salesDayCount: 0, lastUploadAt: null, locationCount: 0 }),
];

function rows(region: HTMLElement): string[][] {
  return within(region).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
}

test('every organization with its counts, “No admin yet” and “None yet”; filters by name and status', async () => {
  const api = consoleApi();
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: ORGS });
  renderAt('/admin/orgs', api);
  const table = await screen.findByRole('region', { name: 'Organizations' });
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
    'Name', 'Status', 'Admins', 'Members', 'Invited', 'Locations', 'Days of sales', 'Last upload', 'Created',
  ]);
  expect(rows(table)).toEqual([
    ['Sample Restaurant Group', 'Active', '1', '3', '1', '2', '400', 'Oct 1, 2026', 'Sep 1, 2026'],
    ['Sample Harbor Kitchen', 'Suspended', '1', '3', '1', '2', '400', 'Oct 1, 2026', 'Sep 1, 2026'],
    ['Sample Ski Bar', 'Active', 'No admin yet', '3', '1', '0', '0', 'None yet', 'Sep 1, 2026'],
  ]);
  expect(within(table).getByRole('link', { name: 'Sample Harbor Kitchen' }).getAttribute('href')).toBe('/admin/orgs/o2');

  fireEvent.change(screen.getByRole('textbox', { name: 'Filter by name' }), { target: { value: 'ski' } });
  expect(rows(screen.getByRole('region', { name: 'Organizations' })).map((row) => row[0])).toEqual(['Sample Ski Bar']);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter by name' }), { target: { value: '' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'suspended' } });
  expect(rows(screen.getByRole('region', { name: 'Organizations' })).map((row) => row[0])).toEqual(['Sample Harbor Kitchen']);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter by name' }), { target: { value: 'tavern' } });
  expect(screen.getByText('No organizations match these filters.')).toBeTruthy();
  // The filters run in the browser: one read.
  expect(api.calls.filter((call) => call.path === '/api/admin/orgs')).toHaveLength(1);
});

test('empty, loading and error states', async () => {
  const api = consoleApi();
  const first = deferred<unknown>();
  let answer: unknown = first.promise;
  api.routes['GET /api/admin/orgs'] = () => answer;
  renderAt('/admin/orgs', api);
  expect(await screen.findByText('Loading organizations')).toBeTruthy();
  first.resolve(offline());
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  answer = { orgs: [] };
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No organizations yet. Approve a request or create one.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open requests' }).getAttribute('href')).toBe('/admin');
});

test('the table stacks into label and value pairs on phones', async () => {
  setWidth(400);
  const api = consoleApi();
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: ORGS.slice(0, 1) });
  renderAt('/admin/orgs', api);
  const table = await screen.findByRole('region', { name: 'Organizations' });
  expect(within(table).queryByRole('table')).toBeNull();
  const [item] = within(table).getAllByRole('listitem');
  if (item === undefined) throw new Error('no stacked row');
  expect(within(item).getByText('Days of sales')).toBeTruthy();
  expect(within(item).getByText('400')).toBeTruthy();
});

test('New organization (C5): checks its fields, creates it, then opens it with a notice', async () => {
  const admin = emailOf('owner', 'example.org');
  const api = consoleApi();
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: ORGS });
  api.routes['POST /api/admin/orgs'] = () => ({ org: { id: 'o9', name: 'Sample Diner' }, result: { email: admin, outcome: 'invited' } });
  api.routes['GET /api/admin/orgs/o9'] = () => orgDetail({ org: { id: 'o9', name: 'Sample Diner', fromRequestId: null }, locations: [], recent: [] });
  renderAt('/admin/orgs', api);
  await screen.findByRole('region', { name: 'Organizations' });
  fireEvent.click(screen.getByRole('button', { name: 'New organization' }));
  const dialog = screen.getByRole('dialog', { name: 'New organization' });
  expect(within(dialog).getByText('They join as admin the next time they continue with Google with this address. We don’t send email yet. The organization’s admins will see that Townwise staff created it.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create organization' }));
  expect(within(dialog).getByText('Enter the organization’s name, 2 to 120 characters.')).toBeTruthy();
  expect(within(dialog).getByText('Enter an email address.')).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: ' Sample Diner ' } });
  expect(within(dialog).getByText(/Sample Diner’s admins will see that Townwise staff created it\.$/)).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'First admin email' }), { target: { value: 'not an email' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create organization' }));
  expect(within(dialog).getByText('Enter an email address.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'First admin email' }), { target: { value: ` ${admin}` } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create organization' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin/orgs/o9'); });
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/orgs', body: { name: 'Sample Diner', adminEmail: admin } }]);
  expect(await screen.findByRole('heading', { level: 1, name: 'Sample Diner' })).toBeTruthy();
  expect(screen.getByText(`Created Sample Diner. ${admin} joins as its admin the next time they continue with Google.`)).toBeTruthy();
});

test('New organization shows the shared copy when the server refuses, and Cancel closes it', async () => {
  const api = consoleApi();
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: ORGS });
  api.routes['POST /api/admin/orgs'] = () => refusal(503, 'unavailable');
  renderAt('/admin/orgs', api);
  fireEvent.click(await screen.findByRole('button', { name: 'New organization' }));
  const dialog = screen.getByRole('dialog', { name: 'New organization' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Sample Diner' } });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'First admin email' }), { target: { value: emailOf('owner') } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create organization' }));
  expect(await within(dialog).findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'New organization' })).toBeNull();
  expect(window.location.pathname).toBe('/admin/orgs');
});
