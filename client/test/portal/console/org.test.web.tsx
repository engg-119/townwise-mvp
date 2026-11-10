import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { OrgDetail } from '../../../src/portal/console/schemas';
import { ACCESS, offline, refusal, viewAsMe, writes } from '../../helpers/portal';
import {
  auditEvent, CHEF_EMAIL, consoleApi, emailOf, MANAGER_EMAIL, member, orgDetail, OWNER_EMAIL, renderAt, type ConsoleApi,
} from './helpers';

// P21 Organization detail: team edits, locations, suspend and reactivate, View as (C1) and delete with the typed
// name (C7). docs/portal/spec.md 16.4, F5, F6, F8, F13.

afterEach(() => {
  cleanup();
});

const NAME = 'Sample Restaurant Group';
const PATH = '/api/admin/orgs/o1';

function serve(api: ConsoleApi, detail: unknown): void {
  api.routes[`GET ${PATH}`] = () => detail;
  // U13B: the Forecasts section reads the organization's forecast runs.
  api.routes[`GET ${PATH}/forecast-runs`] = () => ({ runs: [] });
  api.routes[`GET ${PATH}/calibrations`] = () => ({ forecasts: { on: false, at: null }, calibrations: [] });
}

function gets(api: ConsoleApi): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === PATH).length;
}

function rowOf(region: HTMLElement, text: string): HTMLElement {
  const row = within(region).getAllByRole('row').find((candidate) => candidate.textContent.includes(text));
  if (row === undefined) throw new Error(`no row with ${text}`);
  return row;
}

test('the header, the team, the locations as metadata only, recent activity, and no delete while active', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByRole('heading', { level: 1, name: NAME })).toBeTruthy();
  expect(screen.getByText('Organization')).toBeTruthy();
  // The facts line: status, created, the request it came from.
  expect(screen.getByText('Created Sep 1, 2026').parentElement?.textContent).toBe('ActiveCreated Sep 1, 2026From request');
  expect(screen.getByRole('link', { name: 'From request' }).getAttribute('href')).toBe('/admin?status=approved&request=r1');
  expect(screen.getByText(`What you change here is listed in ${NAME}’s Townwise staff activity, which its admins see.`)).toBeTruthy();
  expect(screen.queryByText('No admin yet. Add an admin email.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Suspend' })).toBeTruthy();

  const team = screen.getByRole('region', { name: 'Team' });
  expect(within(team).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Email', 'Role', 'Status', 'Since', 'Actions']);
  const manager = rowOf(team, MANAGER_EMAIL);
  expect(within(manager).getByText('Added by Townwise staff')).toBeTruthy();
  expect(within(manager).getByText('Joined Sep 3, 2026')).toBeTruthy();
  expect(within(manager).getByRole('button', { name: `Make ${MANAGER_EMAIL} an admin` })).toBeTruthy();
  const owner = rowOf(team, OWNER_EMAIL);
  expect(within(owner).getByRole('button', { name: `Make ${OWNER_EMAIL} a member` })).toBeTruthy();
  const chef = rowOf(team, CHEF_EMAIL);
  expect(within(chef).getByText('Invited')).toBeTruthy();
  expect(within(chef).getByText('Invited Sep 2, 2026')).toBeTruthy();
  // Invitations have no View as and no role change; they are removed as invitations.
  expect(within(chef).queryByRole('button', { name: /^View as/ })).toBeNull();
  expect(within(chef).getByRole('button', { name: `Remove the invitation for ${CHEF_EMAIL}` })).toBeTruthy();
  expect(screen.getByText('Addresses you add here show as added by Townwise staff. Don’t add your own addresses.')).toBeTruthy();

  const locations = screen.getByRole('region', { name: 'Locations' });
  expect(within(locations).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
    'Name', 'Town', 'Days', 'First day', 'Last day', 'Notes', 'Last upload',
  ]);
  expect(within(rowOf(locations, 'Hanover, NH')).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
    'Hanover', 'Hanover, NH', '400', 'Jan 1, 2025', 'Feb 4, 2026', '2', 'Feb 5, 2026',
  ]);
  expect(screen.getByText('Sales figures and notes are visible only through View as.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open as admin' })).toBeNull();

  const activity = screen.getByRole('region', { name: 'Recent activity' });
  expect(within(activity).getByText(`Added ${CHEF_EMAIL} as member`)).toBeTruthy();
  expect(within(activity).getByText('Admin')).toBeTruthy();
  expect(screen.getByRole('link', { name: `See ${NAME} in the audit log` }).getAttribute('href')).toBe('/admin/audit?orgId=o1');

  expect(screen.getByText(`Suspend ${NAME} before deleting it.`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete organization' })).toBeNull();
});

test('staff never see sales figures or note text here, whatever the response carries (D7)', async () => {
  const api = consoleApi();
  const detail = orgDetail();
  serve(api, {
    ...detail,
    locations: detail.locations.map((location) => ({
      ...location,
      coverage: { ...location.coverage, guestsDayCount: 400, netSalesDayCount: 380, missingDays: 0, netSalesCents: 98765400, guests: 43210 },
      months: [{ month: '2026-01', guests: 43210, netSalesCents: 98765400 }],
      notes: [{ detail: 'Private party for the Smith wedding' }],
    })),
  });
  renderAt('/admin/orgs/o1', api);
  await screen.findByRole('region', { name: 'Locations' });
  const text = document.body.textContent;
  for (const leak of ['98765400', '987,654', '43210', '43,210', 'Smith wedding', '380']) expect(text).not.toContain(leak);
});

test('no admin yet; created by staff; no locations yet; nothing recorded yet', async () => {
  const api = consoleApi();
  serve(api, orgDetail({
    org: { fromRequestId: null },
    members: [member('m9', emailOf('owner', 'example.org'), { role: 'org_admin', status: 'invited', joinedAt: null, addedByStaff: true })],
    locations: [],
    recent: [],
  }));
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByText('No admin yet. Add an admin email.')).toBeTruthy();
  expect(screen.getByText('Created Sep 1, 2026 by Townwise staff')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'From request' })).toBeNull();
  expect(screen.getByText('No locations yet. The first admin adds one after joining.')).toBeTruthy();
  expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
});

test.each<[string, () => unknown]>([
  ['404', () => refusal(404, 'not_found')],
  ['a malformed id (400)', () => refusal(400, 'invalid_request')],
])('%s: this organization doesn’t exist, with a way back', async (_name, answer) => {
  const api = consoleApi();
  api.routes[`GET ${PATH}`] = answer;
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByText('This organization doesn’t exist.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Back to organizations' }).getAttribute('href')).toBe('/admin/orgs');
});

test('a network error offers Try again', async () => {
  const api = consoleApi();
  let fail = true;
  api.routes[`GET ${PATH}`] = () => (fail ? offline() : orgDetail());
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { level: 1, name: NAME })).toBeTruthy();
});

test('Rename: prefilled, checked, sent, then the page reads the organization again and says Saved.', async () => {
  const api = consoleApi();
  let detail = orgDetail();
  api.routes[`GET ${PATH}`] = () => detail;
  api.routes[`PATCH ${PATH}`] = (body) => {
    detail = orgDetail({ org: { name: (body as { name: string }).name } });
    return { org: detail.org };
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
  const dialog = screen.getByRole('dialog', { name: `Rename ${NAME}` });
  expect(within(dialog).getByText('Its admins see the new name, and the change, in their Townwise staff activity.')).toBeTruthy();
  const field = within(dialog).getByRole('textbox', { name: 'Organization name' });
  expect((field as HTMLInputElement).value).toBe(NAME);
  fireEvent.change(field, { target: { value: 'X' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
  expect(within(dialog).getByText('Enter the organization’s name, 2 to 120 characters.')).toBeTruthy();
  fireEvent.change(field, { target: { value: ' Sample Group ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Sample Group' })).toBeTruthy();
  expect(screen.getByText('Saved.')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: `Rename ${NAME}` })).toBeNull();
  expect(writes(api)).toEqual([{ method: 'PATCH', path: PATH, body: { name: 'Sample Group' } }]);
  expect(gets(api)).toBe(2);
});

test('Suspend confirms first; once suspended, Reactivate and Delete organization appear', async () => {
  const api = consoleApi();
  let status: 'active' | 'suspended' = 'active';
  api.routes[`GET ${PATH}`] = () => orgDetail({ org: { status } });
  api.routes[`PATCH ${PATH}`] = (body) => {
    status = (body as { status: 'active' | 'suspended' }).status;
    return { org: orgDetail({ org: { status } }).org };
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
  const dialog = screen.getByRole('dialog', { name: `Suspend ${NAME}?` });
  expect(within(dialog).getByText(`Members of ${NAME} lose access until you reactivate it. Data is kept.`)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
  expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeTruthy();
  expect(screen.getByText('Suspended')).toBeTruthy();
  expect(screen.getByText(`Members of ${NAME} see that access is paused. Data is kept.`)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete organization' })).toBeTruthy();
  expect(screen.queryByText(`Suspend ${NAME} before deleting it.`)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
  expect(await screen.findByRole('button', { name: 'Suspend' })).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'PATCH', path: PATH, body: { status: 'suspended' } },
    { method: 'PATCH', path: PATH, body: { status: 'active' } },
  ]);
});

test('Delete organization (C7): only suspended, the typed name, then the list with “Deleted {org}.”', async () => {
  const api = consoleApi();
  serve(api, orgDetail({ org: { status: 'suspended' } }));
  api.routes['GET /api/admin/orgs'] = () => ({ orgs: [] });
  api.routes[`DELETE ${PATH}`] = () => ({ deletedDays: 400, deletedUploads: 1, deletedNotes: 2, deletedLocations: 1, deletedSeats: 3, redactedEvents: 9 });
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }));
  const dialog = screen.getByRole('dialog', { name: `Delete ${NAME}` });
  expect(within(dialog).getByText(`This deletes ${NAME}: its 1 location, their sales data and notes, its team and its request. The audit log keeps the events, with the organization’s and locations’ names removed. This can’t be undone.`)).toBeTruthy();
  const confirm = within(dialog).getByRole('button', { name: 'Delete organization' });
  expect(confirm.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(confirm);
  expect(writes(api)).toEqual([]);
  const typed = within(dialog).getByRole('textbox', { name: `Type ${NAME} to confirm.` });
  fireEvent.change(typed, { target: { value: 'Sample Restaurant' } });
  expect(within(dialog).getByRole('button', { name: 'Delete organization' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.change(typed, { target: { value: `${NAME} ` } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete organization' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin/orgs'); });
  expect(writes(api)).toEqual([{ method: 'DELETE', path: PATH, body: undefined }]);
  expect(await screen.findByText(`Deleted ${NAME}.`)).toBeTruthy();
});

test('Delete refused because it isn’t suspended anymore: the dialog says so', async () => {
  const api = consoleApi();
  serve(api, orgDetail({ org: { status: 'suspended' } }));
  api.routes[`DELETE ${PATH}`] = () => refusal(409, 'org_not_suspended');
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }));
  const dialog = screen.getByRole('dialog', { name: `Delete ${NAME}` });
  fireEvent.change(within(dialog).getByRole('textbox', { name: `Type ${NAME} to confirm.` }), { target: { value: NAME } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete organization' }));
  expect(await within(dialog).findByText(`Suspend ${NAME} before deleting it.`)).toBeTruthy();
  expect(window.location.pathname).toBe('/admin/orgs/o1');
});

test('Add people: one per line or comma separated, the role, one result per address, then the team again', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  const added = emailOf('server');
  api.routes[`POST ${PATH}/members`] = () => ({
    results: [
      { email: added, outcome: 'invited' },
      { email: CHEF_EMAIL, outcome: 'already_invited' },
      { email: MANAGER_EMAIL, outcome: 'already_member' },
      { email: 'host@example', outcome: 'invalid' },
    ],
    members: [],
  });
  renderAt('/admin/orgs/o1', api);
  const panel = await screen.findByRole('region', { name: 'Add people' });
  fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
  expect(within(panel).getByText('Enter at least one email address.')).toBeTruthy();
  const field = within(panel).getByRole('textbox', { name: 'Email addresses' });
  fireEvent.change(field, { target: { value: Array.from({ length: 21 }, (_, n) => emailOf(`p${String(n)}`)).join(',') } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
  expect(within(panel).getByText('Add up to 20 addresses at a time.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  fireEvent.change(field, { target: { value: `${added}\n${CHEF_EMAIL}, ${MANAGER_EMAIL}\nhost@example` } });
  fireEvent.change(within(panel).getByRole('combobox', { name: 'Role' }), { target: { value: 'org_admin' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
  expect(await within(panel).findByText(`${added}: Added. They can join the next time they continue with Google.`)).toBeTruthy();
  expect(within(panel).getByText(`${CHEF_EMAIL}: Already invited.`)).toBeTruthy();
  expect(within(panel).getByText(`${MANAGER_EMAIL}: Already on the team.`)).toBeTruthy();
  expect(within(panel).getByText('host@example: That isn’t an email address.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: `${PATH}/members`, body: { emails: [added, CHEF_EMAIL, MANAGER_EMAIL, 'host@example'], role: 'org_admin' } },
  ]);
  expect((field as HTMLTextAreaElement).value).toBe('');
  await waitFor(() => { expect(gets(api)).toBe(2); });
});

test('Add people at the limit says so', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  api.routes[`POST ${PATH}/members`] = () => refusal(409, 'member_limit');
  renderAt('/admin/orgs/o1', api);
  const panel = await screen.findByRole('region', { name: 'Add people' });
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Email addresses' }), { target: { value: emailOf('server') } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
  expect(await within(panel).findByText(`${NAME} has reached 200 people.`)).toBeTruthy();
});

test('role changes: Make admin saves; the last admin can’t be made a member', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  api.routes[`PATCH ${PATH}/members/m2`] = () => ({ member: member('m2', MANAGER_EMAIL, { role: 'org_admin' }) });
  api.routes[`PATCH ${PATH}/members/m1`] = () => refusal(409, 'last_admin');
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: `Make ${MANAGER_EMAIL} an admin` }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: `Make ${OWNER_EMAIL} a member` }));
  expect(await screen.findByText(`${NAME} needs at least one admin. Make someone else an admin first.`)).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'PATCH', path: `${PATH}/members/m2`, body: { role: 'org_admin' } },
    { method: 'PATCH', path: `${PATH}/members/m1`, body: { role: 'member' } },
  ]);
});

test('Remove and Remove invitation confirm first, then delete; the last admin is refused in the dialog', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  api.routes[`DELETE ${PATH}/members/m2`] = () => null;
  api.routes[`DELETE ${PATH}/members/m3`] = () => null;
  api.routes[`DELETE ${PATH}/members/m1`] = () => refusal(409, 'last_admin');
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: `Remove ${MANAGER_EMAIL}` }));
  let dialog = screen.getByRole('dialog', { name: `Remove ${MANAGER_EMAIL}?` });
  expect(within(dialog).getByText('They lose access on their next visit. Their notes and uploads stay.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: `Remove the invitation for ${CHEF_EMAIL}` }));
  dialog = screen.getByRole('dialog', { name: `Remove the invitation for ${CHEF_EMAIL}?` });
  expect(within(dialog).getByText(`They can’t join ${NAME} with it anymore.`)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove invitation' }));
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: `Remove the invitation for ${CHEF_EMAIL}?` })).toBeNull(); });

  fireEvent.click(screen.getByRole('button', { name: `Remove ${OWNER_EMAIL}` }));
  dialog = screen.getByRole('dialog', { name: `Remove ${OWNER_EMAIL}?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByText(`${NAME} needs at least one admin. Make someone else an admin first.`)).toBeTruthy();
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([
    `DELETE ${PATH}/members/m2`, `DELETE ${PATH}/members/m3`, `DELETE ${PATH}/members/m1`,
  ]);
});

describe('a change that saved, then the page couldn’t read the organization again', () => {
  const STALE = 'This page couldn’t load the latest, so it may be out of date.';

  function failingRefresh(api: ConsoleApi): { fail: () => void; heal: (detail: unknown) => void } {
    let next: unknown = orgDetail();
    let failing = false;
    api.routes[`GET ${PATH}`] = () => (failing ? offline() : next);
    // U13B: the Forecasts section's read, which this failure leaves alone.
    api.routes[`GET ${PATH}/forecast-runs`] = () => ({ runs: [] });
    api.routes[`GET ${PATH}/calibrations`] = () => ({ forecasts: { on: false, at: null }, calibrations: [] });
    return { fail: () => { failing = true; }, heal: (detail) => { failing = false; next = detail; } };
  }

  test('Remove says Saved., keeps no write error, and Try again reads the team again', async () => {
    const api = consoleApi();
    const refresh = failingRefresh(api);
    api.routes[`DELETE ${PATH}/members/m2`] = () => { refresh.fail(); return null; };
    renderAt('/admin/orgs/o1', api);
    fireEvent.click(await screen.findByRole('button', { name: `Remove ${MANAGER_EMAIL}` }));
    fireEvent.click(within(screen.getByRole('dialog', { name: `Remove ${MANAGER_EMAIL}?` })).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.queryByText('Can’t reach Townwise. Check your connection and try again.')).toBeNull();
    refresh.heal(orgDetail({ members: [member('m1', OWNER_EMAIL, { role: 'org_admin' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(screen.queryByText(STALE)).toBeNull(); });
    expect(within(screen.getByRole('region', { name: 'Team' })).queryByText(MANAGER_EMAIL)).toBeNull();
    // Try again read the organization; it sent nothing again.
    expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`DELETE ${PATH}/members/m2`]);
  });

  test('Rename closes with Saved. instead of showing a failure in the dialog', async () => {
    const api = consoleApi();
    const refresh = failingRefresh(api);
    api.routes[`PATCH ${PATH}`] = () => { refresh.fail(); return { org: orgDetail({ org: { name: 'Sample Group' } }).org }; };
    renderAt('/admin/orgs/o1', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: `Rename ${NAME}` });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Organization name' }), { target: { value: 'Sample Group' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: `Rename ${NAME}` })).toBeNull();
    expect(screen.getByText(STALE)).toBeTruthy();
  });

  test('Add people shows each address’s result, and Make admin says Saved., with no write error', async () => {
    const api = consoleApi();
    const refresh = failingRefresh(api);
    const added = emailOf('server');
    api.routes[`POST ${PATH}/members`] = () => { refresh.fail(); return { results: [{ email: added, outcome: 'invited' }], members: [] }; };
    api.routes[`PATCH ${PATH}/members/m2`] = () => ({ member: member('m2', MANAGER_EMAIL, { role: 'org_admin' }) });
    renderAt('/admin/orgs/o1', api);
    const panel = await screen.findByRole('region', { name: 'Add people' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Email addresses' }), { target: { value: added } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    expect(await within(panel).findByText(`${added}: Added. They can join the next time they continue with Google.`)).toBeTruthy();
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(within(panel).queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Make ${MANAGER_EMAIL} an admin` }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByText('Can’t reach Townwise. Check your connection and try again.')).toBeNull();
  });
});

test('View as on a member row finds the person by email, then opens what they see under the banner', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  const lookup = `/api/admin/people/lookup?q=${encodeURIComponent(MANAGER_EMAIL)}`;
  api.routes[`GET ${lookup}`] = () => ({
    person: { userId: 'u2', email: MANAGER_EMAIL, kind: 'member', org: { id: 'o1', name: NAME }, since: null, staffTwoStep: null },
  });
  api.routes['POST /api/admin/view-as'] = () => {
    api.me = viewAsMe(ACCESS.member);
    return api.me;
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: `View as ${MANAGER_EMAIL}` }));
  const dialog = screen.getByRole('dialog', { name: `View Townwise as ${MANAGER_EMAIL}` });
  expect(within(dialog).getByText(`You’ll see what ${MANAGER_EMAIL} sees, read-only, for 30 minutes. This is recorded in the audit log with your reason, and ${NAME}’s admins can see it. It ends early if ${MANAGER_EMAIL} joins, leaves or changes organization.`)).toBeTruthy();
  expect(within(dialog).getByText('For example, the question you’re helping with.')).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), { target: { value: 'Helping with a question.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start viewing' }));
  await waitFor(() => { expect(window.location.pathname).not.toMatch(/^\/admin/); });
  expect(api.calls.some((call) => call.path === lookup)).toBe(true);
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as', body: { userId: 'u2', reason: 'Helping with a question.' } }]);
  expect(await screen.findByRole('region', { name: 'View-as' })).toBeTruthy();
});

test('View as on a member whose account is gone says so, and starts nothing', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(MANAGER_EMAIL)}`] = () => ({ person: null });
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: `View as ${MANAGER_EMAIL}` }));
  const dialog = screen.getByRole('dialog', { name: `View Townwise as ${MANAGER_EMAIL}` });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), { target: { value: 'Helping with a question.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start viewing' }));
  expect(await within(dialog).findByText('This person no longer exists.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('recent activity shows who was viewed as, and staff events that didn’t take effect', async () => {
  const api = consoleApi();
  serve(api, orgDetail({
    recent: [
      auditEvent('e2', {
        actorEmail: emailOf('staff'), actorRole: 'superadmin', viewAs: { targetEmail: MANAGER_EMAIL }, action: 'view_as.ended',
        summary: 'Ended view-as', details: { endReason: 'ended' },
      }),
      auditEvent('e3', {
        actorEmail: emailOf('staff'), actorRole: 'superadmin', action: 'member.role_changed',
        summary: `Changed ${OWNER_EMAIL} from admin to member. Didn’t take effect (last_admin).`, details: {},
      }),
    ],
  }));
  renderAt('/admin/orgs/o1', api);
  const activity = await screen.findByRole('region', { name: 'Recent activity' });
  expect(within(activity).getByText(`Townwise staff, viewing as ${MANAGER_EMAIL}`)).toBeTruthy();
  expect(within(activity).getByText(`Changed ${OWNER_EMAIL} from admin to member. Didn’t take effect (last_admin).`)).toBeTruthy();
});

test('the header links the request it came from, with the day it was sent, from the organization read alone', async () => {
  const api = consoleApi();
  serve(api, orgDetail({ org: { fromRequestSentAt: '2026-08-20T15:00:00.000Z' } }));
  renderAt('/admin/orgs/o1', api);
  const link = await screen.findByRole('link', { name: 'From request Aug 20, 2026' });
  expect(link.getAttribute('href')).toBe('/admin?status=approved&request=r1');
  expect(screen.getByText('Created Sep 1, 2026').parentElement?.textContent).toBe('ActiveCreated Sep 1, 2026From request Aug 20, 2026');
  // No list of approved requests is read for it.
  expect(api.calls.filter((call) => call.path === '/api/admin/requests?status=approved')).toEqual([]);
});

describe('a write that finds the organization deleted (404) shows the page’s 404 state', () => {
  const ADDED = emailOf('server');

  test.each<[string, Partial<OrgDetail['org']>, string, () => Promise<void>]>([
    ['Rename', {}, `PATCH ${PATH}`, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: `Rename ${NAME}` })).getByRole('button', { name: 'Save name' }));
    }],
    ['Suspend', {}, `PATCH ${PATH}`, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: `Suspend ${NAME}?` })).getByRole('button', { name: 'Suspend' }));
    }],
    ['Reactivate', { status: 'suspended' }, `PATCH ${PATH}`, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    }],
    ['Delete organization', { status: 'suspended' }, `DELETE ${PATH}`, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }));
      const dialog = screen.getByRole('dialog', { name: `Delete ${NAME}` });
      fireEvent.change(within(dialog).getByRole('textbox', { name: `Type ${NAME} to confirm.` }), { target: { value: NAME } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete organization' }));
    }],
    ['Add people', {}, `POST ${PATH}/members`, async () => {
      const panel = await screen.findByRole('region', { name: 'Add people' });
      fireEvent.change(within(panel).getByRole('textbox', { name: 'Email addresses' }), { target: { value: ADDED } });
      fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    }],
  ])('%s', async (_name, org, route, write) => {
    const api = consoleApi();
    serve(api, orgDetail({ org }));
    api.routes[route] = () => refusal(404, 'not_found');
    renderAt('/admin/orgs/o1', api);
    await write();
    const line = await screen.findByText('This organization doesn’t exist.');
    expect(screen.getByRole('link', { name: 'Back to organizations' }).getAttribute('href')).toBe('/admin/orgs');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Team' })).toBeNull();
    // The control that opened it is gone, so focus moves to the line that says why.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.contains(line)).toBe(true);
    expect(writes(api)).toHaveLength(1);
  });
});

describe('a change that saved, then a read that finds the organization deleted, shows the 404 state instead of Saved.', () => {
  test.each<[string, Partial<OrgDetail['org']>, string, unknown, () => Promise<void>]>([
    ['Rename', {}, `PATCH ${PATH}`, { org: orgDetail().org }, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: `Rename ${NAME}` })).getByRole('button', { name: 'Save name' }));
    }],
    ['Reactivate', { status: 'suspended' }, `PATCH ${PATH}`, { org: orgDetail().org }, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    }],
    ['Make admin', {}, `PATCH ${PATH}/members/m2`, { member: member('m2', MANAGER_EMAIL, { role: 'org_admin' }) }, async () => {
      fireEvent.click(await screen.findByRole('button', { name: `Make ${MANAGER_EMAIL} an admin` }));
    }],
    ['Remove', {}, `DELETE ${PATH}/members/m2`, null, async () => {
      fireEvent.click(await screen.findByRole('button', { name: `Remove ${MANAGER_EMAIL}` }));
      fireEvent.click(within(screen.getByRole('dialog', { name: `Remove ${MANAGER_EMAIL}?` })).getByRole('button', { name: 'Remove' }));
    }],
  ])('%s', async (_name, org, route, answer, write) => {
    const api = consoleApi();
    // Another staff member deletes the organization just after this change lands.
    let deleted = false;
    api.routes[`GET ${PATH}`] = () => (deleted ? refusal(404, 'not_found') : orgDetail({ org }));
    api.routes[route] = () => { deleted = true; return answer; };
    renderAt('/admin/orgs/o1', api);
    await write();
    const line = await screen.findByText('This organization doesn’t exist.');
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The control that was pressed is gone, so focus moves to the line that says why.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.contains(line)).toBe(true);
    expect(writes(api)).toHaveLength(1);
  });
});

test('U13B: the Forecasts section sits after the locations, says drafts stay hidden until published, and offers the import', async () => {
  const api = consoleApi();
  serve(api, orgDetail());
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByRole('heading', { name: 'Forecasts' })).toBeTruthy();
  expect(screen.getByText(`A forecast is a draft until you publish it. While forecasts are on, a calibration that passes every check publishes itself. ${NAME}’s members and TownwiseAI see only published forecasts, never the model. Each import, publish, withdrawal and deletion is listed in ${NAME}’s Townwise staff activity.`)).toBeTruthy();
  expect(await screen.findByText('No forecast imported for Hanover.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Import a forecast' })).toBeTruthy();
  const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
  expect(headings.indexOf('Forecasts')).toBeGreaterThan(headings.indexOf('Locations'));
  expect(headings.indexOf('Forecasts')).toBeLessThan(headings.indexOf('Recent activity'));
  expect(api.calls.some((call) => call.method === 'GET' && call.path === `${PATH}/forecast-runs`)).toBe(true);
});
