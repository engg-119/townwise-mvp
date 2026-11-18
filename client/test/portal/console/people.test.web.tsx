import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { ACCESS, deferred, offline, refusal, STAFF_EMAIL, viewAsMe, writes } from '../../helpers/portal';
import { CHEF_EMAIL, consoleApi, emailOf, MANAGER_EMAIL, OWNER_EMAIL, person, renderAt, setWidth, type ConsoleApi } from './helpers';
import { choicesOf, choose } from '../../helpers/select';

// P22 People: everyone across organizations, the lookup, View as (C1), sign out everywhere, and Delete person
// (C7, the typed email). docs/portal/spec.md 16.4, F7, F13.

afterEach(() => {
  cleanup();
  setWidth(1280);
});

const ORG = { id: 'o1', name: 'Sample Restaurant Group' };
const OPS_EMAIL = emailOf('ops');
const GM_EMAIL = emailOf('gm', 'example.org');
const BARTENDER_EMAIL = emailOf('bartender', 'example.net');

const PEOPLE = [
  person(STAFF_EMAIL, 'staff', { userId: 's1', since: null, staffTwoStep: { state: 'on', since: '2026-08-01T15:00:00.000Z' } }),
  person(OPS_EMAIL, 'staff', { since: null, staffTwoStep: { state: 'not_signed_in' } }),
  person(OWNER_EMAIL, 'org_admin', { userId: 'u1', org: ORG }),
  person(MANAGER_EMAIL, 'member', { userId: 'u2', org: ORG }),
  person(CHEF_EMAIL, 'invited', { org: ORG }),
  person(GM_EMAIL, 'pending', { userId: 'u3' }),
  person(BARTENDER_EMAIL, 'rejected', { userId: 'u4' }),
];

function serve(api: ConsoleApi, people: unknown[] = PEOPLE, truncated = false): void {
  api.routes['GET /api/admin/people'] = () => ({ people, truncated });
}

function rowOf(region: HTMLElement, text: string): HTMLElement {
  const row = within(region).getAllByRole('row').find((candidate) => (candidate.textContent).startsWith(text));
  if (row === undefined) throw new Error(`no row for ${text}`);
  return row;
}

test('everyone, with kind, organization, since and two-step; actions only on non-staff rows', async () => {
  const api = consoleApi();
  serve(api);
  renderAt('/admin/people', api);
  const table = await screen.findByRole('region', { name: 'Everyone' });
  expect(screen.getByText('Everyone Townwise has a record for: staff, members, invited emails and requesters.')).toBeTruthy();
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Email', 'Kind', 'Organization', 'Since', 'Two-step', 'Actions']);

  const you = rowOf(table, STAFF_EMAIL);
  expect(within(you).getByText('You')).toBeTruthy();
  expect(within(you).getByText('Townwise staff')).toBeTruthy();
  expect(within(you).getByText('On since Aug 1, 2026')).toBeTruthy();
  expect(within(you).queryAllByRole('button')).toEqual([]);
  expect(within(rowOf(table, OPS_EMAIL)).getByText('Not signed in yet')).toBeTruthy();

  const owner = rowOf(table, OWNER_EMAIL);
  expect(within(owner).getByText('Admin')).toBeTruthy();
  expect(within(owner).getByRole('link', { name: ORG.name }).getAttribute('href')).toBe('/admin/orgs/o1');
  expect(within(owner).getByRole('button', { name: `View as ${OWNER_EMAIL}` })).toBeTruthy();
  expect(within(owner).getByRole('button', { name: `Sign out ${OWNER_EMAIL} everywhere` })).toBeTruthy();
  // A seated person can't be deleted until removed: the control stays focusable and says why.
  const remove = within(owner).getByRole('button', { name: `Delete ${OWNER_EMAIL}` });
  expect(remove.getAttribute('aria-disabled')).toBe('true');
  const helper = document.getElementById(remove.getAttribute('aria-describedby') ?? '');
  expect(helper?.textContent).toBe(`Remove ${OWNER_EMAIL} from ${ORG.name} first.`);

  // An invited address has no kit user: no View as or Sign out, but it can be deleted.
  const chef = rowOf(table, CHEF_EMAIL);
  expect(within(chef).getByText('Invited')).toBeTruthy();
  expect(within(chef).queryByRole('button', { name: /^View as/ })).toBeNull();
  expect(within(chef).getByRole('button', { name: `Delete ${CHEF_EMAIL}` }).getAttribute('aria-disabled')).toBeNull();
  expect(within(rowOf(table, GM_EMAIL)).getByText('Requested')).toBeTruthy();
  expect(within(rowOf(table, GM_EMAIL)).getByText('None')).toBeTruthy();
  expect(screen.getByText('Townwise staff can’t be viewed as, signed out or deleted from here. Two-step applies to staff rows only.')).toBeTruthy();
});

test('the kind filter asks the server; the search runs in the browser; a truncated list says so', async () => {
  const api = consoleApi();
  serve(api, PEOPLE, true);
  api.routes['GET /api/admin/people?kind=rejected'] = () => ({ people: [PEOPLE[6]], truncated: false });
  renderAt('/admin/people', api);
  await screen.findByRole('region', { name: 'Everyone' });
  expect(screen.getByText('Showing the first 1,000 people. Use the search or the lookup.')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search email or organization' }), { target: { value: 'restaurant' } });
  const names = (): string[] => within(screen.getByRole('region', { name: 'Everyone' })).getAllByRole('row').slice(1)
    .map((row) => row.querySelector('[role="cell"]')?.textContent ?? '');
  expect(names()).toEqual([OWNER_EMAIL, MANAGER_EMAIL, CHEF_EMAIL]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search email or organization' }), { target: { value: 'nobody' } });
  expect(screen.getByText('No one matches.')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search email or organization' }), { target: { value: '' } });
  const kinds = screen.getByRole('combobox', { name: 'Kind' });
  expect(choicesOf(kinds)).toEqual([
    'All kinds', 'Townwise staff', 'Admin', 'Member', 'Invited', 'Requested', 'Rejected', 'Removed', 'Signed in only',
  ]);
  choose(kinds, 'Rejected');
  expect(await screen.findByText('Loading people')).toBeTruthy();
  await waitFor(() => { expect(names()).toEqual([BARTENDER_EMAIL]); });
  expect(api.calls.some((call) => call.path === '/api/admin/people?kind=rejected')).toBe(true);
});

test('loading and the network copy with Try again', async () => {
  const api = consoleApi();
  let fail = true;
  api.routes['GET /api/admin/people'] = () => (fail ? offline() : { people: PEOPLE, truncated: false });
  renderAt('/admin/people', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('region', { name: 'Everyone' })).toBeTruthy();
});

test('the table stacks on phones, actions included', async () => {
  setWidth(400);
  const api = consoleApi();
  serve(api, [PEOPLE[5]]);
  renderAt('/admin/people', api);
  const table = await screen.findByRole('region', { name: 'Everyone' });
  expect(within(table).queryByRole('table')).toBeNull();
  const [item] = within(table).getAllByRole('listitem');
  if (item === undefined) throw new Error('no stacked row');
  expect(within(item).getByText('Kind')).toBeTruthy();
  expect(within(item).getByRole('button', { name: `View as ${GM_EMAIL}` })).toBeTruthy();
});

test('the lookup finds a signed-in-only person by exact email, or says no one has that email', async () => {
  const api = consoleApi();
  serve(api);
  const cook = emailOf('cook');
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(cook)}`] = () => ({ person: person(cook, 'signed_in', { userId: 'u7' }) });
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(emailOf('nobody'))}`] = () => ({ person: null });
  renderAt('/admin/people', api);
  const panel = await screen.findByRole('region', { name: 'Lookup' });
  expect(within(panel).getByText('Someone who signed in but was never added and never requested access shows up only here.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Look up' }));
  expect(within(panel).getByText('Enter an email address.')).toBeTruthy();
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Email' }), { target: { value: ` ${cook} ` } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Look up' }));
  const result = await within(panel).findByRole('region', { name: 'Lookup result' });
  expect(within(result).getByText('Signed in only')).toBeTruthy();
  expect(within(result).getByRole('button', { name: `View as ${cook}` })).toBeTruthy();
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Email' }), { target: { value: emailOf('nobody') } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Look up' }));
  expect(await within(panel).findByText('No one with that email has signed in or been added.')).toBeTruthy();
});

function lookups(api: ConsoleApi): string[] {
  return api.calls.filter((call) => call.path.startsWith('/api/admin/people/lookup')).map((call) => call.path);
}

test('a lookup that isn’t an email address says so without asking the server; a 400 reads the same', async () => {
  const api = consoleApi();
  serve(api);
  const odd = emailOf('odd');
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(odd)}`] = () => refusal(400, 'invalid_request');
  renderAt('/admin/people', api);
  const panel = await screen.findByRole('region', { name: 'Lookup' });
  const field = within(panel).getByRole('textbox', { name: 'Email' });
  fireEvent.change(field, { target: { value: 'bob' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Look up' }));
  expect(within(panel).getByText('Enter an email address.')).toBeTruthy();
  expect(lookups(api)).toEqual([]);
  fireEvent.change(field, { target: { value: odd } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Look up' }));
  await waitFor(() => { expect(lookups(api)).toHaveLength(1); });
  expect(await within(panel).findByText('Enter an email address.')).toBeTruthy();
  expect(within(panel).queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
});

test('a lookup started while another runs takes over: Enter sends it, and the older answer is dropped', async () => {
  const api = consoleApi();
  serve(api);
  const first = emailOf('alpha');
  const second = emailOf('bravo');
  const slow = deferred<unknown>();
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(first)}`] = () => slow.promise;
  api.routes[`GET /api/admin/people/lookup?q=${encodeURIComponent(second)}`] = () => ({ person: null });
  renderAt('/admin/people', api);
  const panel = await screen.findByRole('region', { name: 'Lookup' });
  const field = within(panel).getByRole('textbox', { name: 'Email' });
  fireEvent.change(field, { target: { value: first } });
  fireEvent.keyDown(field, { key: 'Enter' });
  fireEvent.change(field, { target: { value: second } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(await within(panel).findByText('No one with that email has signed in or been added.')).toBeTruthy();
  await act(async () => { slow.resolve({ person: person(first, 'signed_in', { userId: 'u7' }) }); await slow.promise; });
  expect(within(panel).queryByRole('region', { name: 'Lookup result' })).toBeNull();
  expect(within(panel).getByText('No one with that email has signed in or been added.')).toBeTruthy();
  expect(lookups(api)).toEqual([first, second].map((email) => `/api/admin/people/lookup?q=${encodeURIComponent(email)}`));
});

test('Sign out everywhere confirms, sends {}, then says so', async () => {
  const api = consoleApi();
  serve(api);
  api.routes['POST /api/admin/people/u2/sign-out-everywhere'] = () => ({ revoked: 3 });
  renderAt('/admin/people', api);
  fireEvent.click(await screen.findByRole('button', { name: `Sign out ${MANAGER_EMAIL} everywhere` }));
  const dialog = screen.getByRole('dialog', { name: `Sign out ${MANAGER_EMAIL} everywhere?` });
  expect(within(dialog).getByText(`This signs ${MANAGER_EMAIL} out on every device. They can sign in again.`)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
  expect(await screen.findByText(`Signed ${MANAGER_EMAIL} out everywhere.`)).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/people/u2/sign-out-everywhere', body: {} }]);
});

test('Sign out everywhere for a person who is gone (404) closes the dialog and says so on the page, with focus', async () => {
  const api = consoleApi();
  let people = PEOPLE;
  api.routes['GET /api/admin/people'] = () => ({ people, truncated: false });
  api.routes['POST /api/admin/people/u3/sign-out-everywhere'] = () => {
    people = PEOPLE.filter((entry) => entry.email !== GM_EMAIL);
    return refusal(404, 'not_found');
  };
  renderAt('/admin/people', api);
  fireEvent.click(await screen.findByRole('button', { name: `Sign out ${GM_EMAIL} everywhere` }));
  const dialog = screen.getByRole('dialog', { name: `Sign out ${GM_EMAIL} everywhere?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
  const line = await screen.findByText('This person no longer exists.');
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => { expect(screen.queryByRole('button', { name: `Sign out ${GM_EMAIL} everywhere` })).toBeNull(); });
  expect(document.activeElement?.contains(line)).toBe(true);
});

test('Delete person (C7): the typed email, the email in the body, and the runbook line when a kit user remains', async () => {
  const api = consoleApi();
  serve(api);
  api.routes['POST /api/admin/people/delete'] = (body) => ({
    deletedRequests: 1, deletedSeats: 0, redactedEvents: 2,
    kitUserId: (body as { email: string }).email === BARTENDER_EMAIL ? 'u4' : null,
  });
  renderAt('/admin/people', api);
  fireEvent.click(await screen.findByRole('button', { name: `Delete ${BARTENDER_EMAIL}` }));
  let dialog = screen.getByRole('dialog', { name: `Delete ${BARTENDER_EMAIL}` });
  expect(within(dialog).getByText(`This deletes ${BARTENDER_EMAIL}’s requests and invitations, signs them out everywhere, removes their authenticator, and replaces ${BARTENDER_EMAIL} with “deleted person” in the audit log. Their notes and uploads stay with their organization. This can’t be undone.`)).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Delete person' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.change(within(dialog).getByRole('textbox', { name: `Type ${BARTENDER_EMAIL} to confirm.` }), { target: { value: BARTENDER_EMAIL } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete person' }));
  expect(await screen.findByText(`Deleted ${BARTENDER_EMAIL}’s Townwise records. Delete their kit user record by hand (runbook).`)).toBeTruthy();

  fireEvent.click(await screen.findByRole('button', { name: `Delete ${CHEF_EMAIL}` }));
  dialog = screen.getByRole('dialog', { name: `Delete ${CHEF_EMAIL}` });
  fireEvent.change(within(dialog).getByRole('textbox', { name: `Type ${CHEF_EMAIL} to confirm.` }), { target: { value: CHEF_EMAIL } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete person' }));
  expect(await screen.findByText(`Deleted ${CHEF_EMAIL}’s Townwise records.`)).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: '/api/admin/people/delete', body: { email: BARTENDER_EMAIL } },
    { method: 'POST', path: '/api/admin/people/delete', body: { email: CHEF_EMAIL } },
  ]);
  // No email ever goes in a path.
  expect(api.calls.filter((call) => call.path.includes('@'))).toEqual([]);
});

test('Delete person refused while they hold a seat: remove them from their organization first', async () => {
  const api = consoleApi();
  // The list said rejected, but they joined meanwhile.
  serve(api, [person(BARTENDER_EMAIL, 'rejected', { userId: 'u4' })]);
  api.routes['POST /api/admin/people/delete'] = () => refusal(409, 'person_has_seat');
  const lookup = `GET /api/admin/people/lookup?q=${encodeURIComponent(BARTENDER_EMAIL)}`;
  api.routes[lookup] = () => offline();
  renderAt('/admin/people', api);
  fireEvent.click(await screen.findByRole('button', { name: `Delete ${BARTENDER_EMAIL}` }));
  const dialog = screen.getByRole('dialog', { name: `Delete ${BARTENDER_EMAIL}` });
  fireEvent.change(within(dialog).getByRole('textbox', { name: `Type ${BARTENDER_EMAIL} to confirm.` }), { target: { value: BARTENDER_EMAIL } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete person' }));
  // The lookup couldn't say where they are now.
  expect(await within(dialog).findByText(`Remove ${BARTENDER_EMAIL} from their organization first.`)).toBeTruthy();

  // The lookup names the organization they are in now, with a way to its team.
  api.routes[lookup] = () => ({ person: person(BARTENDER_EMAIL, 'member', { userId: 'u4', org: { id: 'o5', name: 'Sample Ski Bar' } }) });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete person' }));
  expect(await within(dialog).findByText(new RegExp(`^Remove ${BARTENDER_EMAIL.replace('.', '\\.')} from Sample Ski Bar first\\.`))).toBeTruthy();
  expect(within(dialog).getByRole('link', { name: 'Open Sample Ski Bar’s team' }).getAttribute('href')).toBe('/admin/orgs/o5');
});

test('View as from People names the organization whose admins will see it, then opens the target’s view', async () => {
  const api = consoleApi();
  serve(api);
  api.routes['POST /api/admin/view-as'] = () => {
    api.me = viewAsMe(ACCESS.member);
    return api.me;
  };
  renderAt('/admin/people', api);
  fireEvent.click(await screen.findByRole('button', { name: `View as ${MANAGER_EMAIL}` }));
  const dialog = screen.getByRole('dialog', { name: `View Townwise as ${MANAGER_EMAIL}` });
  expect(within(dialog).getByText(new RegExp(`your reason, and ${ORG.name}’s admins can see it\\.`))).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason' }), { target: { value: 'Their upload question.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start viewing' }));
  expect(await screen.findByRole('region', { name: 'View-as' })).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as', body: { userId: 'u2', reason: 'Their upload question.' } }]);
});

function lookupRoute(email: string): string {
  return `GET /api/admin/people/lookup?q=${encodeURIComponent(email)}`;
}

async function lookUp(email: string): Promise<HTMLElement> {
  const panel = await screen.findByRole('region', { name: 'Lookup' });
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Email' }), { target: { value: email } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Look up' }));
  return panel;
}

function confirmDelete(email: string): HTMLElement {
  const dialog = screen.getByRole('dialog', { name: `Delete ${email}` });
  fireEvent.change(within(dialog).getByRole('textbox', { name: `Type ${email} to confirm.` }), { target: { value: email } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete person' }));
  return dialog;
}

test('a failed lookup shows the shared copy with Try again, which looks that address up again', async () => {
  const api = consoleApi();
  serve(api);
  const cook = emailOf('cook');
  api.routes[lookupRoute(cook)] = () => offline();
  renderAt('/admin/people', api);
  const panel = await lookUp(cook);
  expect(await within(panel).findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  api.routes[lookupRoute(cook)] = () => ({ person: person(cook, 'signed_in', { userId: 'u7' }) });
  fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
  expect(await within(panel).findByRole('region', { name: 'Lookup result' })).toBeTruthy();
  expect(lookups(api)).toHaveLength(2);
});

test('a delete refused because they took a seat reads the list again: after Cancel the row shows it, Delete disabled, with focus', async () => {
  const api = consoleApi();
  const seat = { id: 'o5', name: 'Sample Ski Bar' };
  let people = [person(BARTENDER_EMAIL, 'rejected', { userId: 'u4' })];
  api.routes['GET /api/admin/people'] = () => ({ people, truncated: false });
  api.routes[lookupRoute(BARTENDER_EMAIL)] = () => ({ person: people[0] });
  api.routes['POST /api/admin/people/delete'] = () => {
    people = [person(BARTENDER_EMAIL, 'member', { userId: 'u4', org: seat })];
    return refusal(409, 'person_has_seat');
  };
  renderAt('/admin/people', api);
  const opener = await screen.findByRole('button', { name: `Delete ${BARTENDER_EMAIL}` });
  opener.focus();
  fireEvent.click(opener);
  const dialog = confirmDelete(BARTENDER_EMAIL);
  expect(await within(dialog).findByText(/^Remove bartender@example\.net from Sample Ski Bar first\./)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  const row = rowOf(screen.getByRole('region', { name: 'Everyone' }), BARTENDER_EMAIL);
  await waitFor(() => { expect(within(row).getByText('Member')).toBeTruthy(); });
  const remove = within(row).getByRole('button', { name: `Delete ${BARTENDER_EMAIL}` });
  expect(remove.getAttribute('aria-disabled')).toBe('true');
  expect(within(row).getByText(`Remove ${BARTENDER_EMAIL} from ${seat.name} first.`)).toBeTruthy();
  // Read again in place, so the opener is still on the page and gets focus back.
  expect(remove).toBe(opener);
  expect(document.activeElement).toBe(opener);
});

test('a delete from the lookup result refused because they took a seat keeps the result up while it reads again, so Cancel returns focus', async () => {
  const api = consoleApi();
  serve(api);
  const seat = { id: 'o5', name: 'Sample Ski Bar' };
  const cook = emailOf('cook');
  let found = person(cook, 'signed_in', { userId: 'u7' });
  // The first lookup and the dialog's own (which names the organization) answer at once; the read again waits.
  const again = deferred<unknown>();
  api.routes[lookupRoute(cook)] = () => (lookups(api).length < 3 ? { person: found } : again.promise);
  api.routes['POST /api/admin/people/delete'] = () => {
    found = person(cook, 'member', { userId: 'u7', org: seat });
    return refusal(409, 'person_has_seat');
  };
  renderAt('/admin/people', api);
  const panel = await lookUp(cook);
  const opener = within(await within(panel).findByRole('region', { name: 'Lookup result' })).getByRole('button', { name: `Delete ${cook}` });
  opener.focus();
  fireEvent.click(opener);
  const dialog = confirmDelete(cook);
  expect(await within(dialog).findByText(/^Remove cook@example\.com from Sample Ski Bar first\./)).toBeTruthy();
  await waitFor(() => { expect(lookups(api)).toHaveLength(3); });
  // While it reads again, the result stays up, opener and all.
  const result = within(panel).getByRole('region', { name: 'Lookup result' });
  expect(within(result).getByRole('button', { name: `Delete ${cook}` })).toBe(opener);
  await act(async () => { again.resolve({ person: found }); await again.promise; });
  expect(within(result).getByText('Member')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  const remove = within(result).getByRole('button', { name: `Delete ${cook}` });
  expect(remove.getAttribute('aria-disabled')).toBe('true');
  expect(remove).toBe(opener);
  expect(document.activeElement).toBe(opener);
});

test('a delete that finds the person gone (404) closes the dialog: their row goes, and focus moves to the line that says so', async () => {
  const api = consoleApi();
  let people = PEOPLE;
  api.routes['GET /api/admin/people'] = () => ({ people, truncated: false });
  api.routes['POST /api/admin/people/delete'] = () => {
    people = PEOPLE.filter((entry) => entry.email !== CHEF_EMAIL);
    return refusal(404, 'not_found');
  };
  renderAt('/admin/people', api);
  const opener = await screen.findByRole('button', { name: `Delete ${CHEF_EMAIL}` });
  opener.focus();
  fireEvent.click(opener);
  confirmDelete(CHEF_EMAIL);
  const line = await screen.findByText('This person no longer exists.');
  expect(screen.queryByRole('dialog')).toBeNull();
  // The list read again in place, without them.
  await waitFor(() => { expect(screen.queryByRole('button', { name: `Delete ${CHEF_EMAIL}` })).toBeNull(); });
  expect(screen.getByRole('region', { name: 'Everyone' })).toBeTruthy();
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement?.contains(line)).toBe(true);
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/people/delete', body: { email: CHEF_EMAIL } }]);
});

test('a delete reloads the list, which takes the opener away, so focus moves to the page’s heading as the toast says so', async () => {
  const api = consoleApi();
  serve(api);
  api.routes['POST /api/admin/people/delete'] = () => ({ deletedRequests: 1, deletedSeats: 0, redactedEvents: 2, kitUserId: null });
  renderAt('/admin/people', api);
  const opener = await screen.findByRole('button', { name: `Delete ${CHEF_EMAIL}` });
  opener.focus();
  fireEvent.click(opener);
  confirmDelete(CHEF_EMAIL);
  const notice = await screen.findByText(`Deleted ${CHEF_EMAIL}’s Townwise records.`);
  await screen.findByRole('region', { name: 'Everyone' });
  // The notice is a toast, which never takes focus (spec 15.7, D55).
  expect(notice.closest('[data-testid="toast"]')).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'People' }));
});

test('the lookup result reads again after a delete, so a deleted person never shows with live buttons', async () => {
  const api = consoleApi();
  serve(api);
  const cook = emailOf('cook');
  let found: unknown = person(cook, 'pending', { userId: 'u7' });
  api.routes[lookupRoute(cook)] = () => ({ person: found });
  api.routes['POST /api/admin/people/delete'] = () => {
    found = null;
    return { deletedRequests: 1, deletedSeats: 0, redactedEvents: 0, kitUserId: null };
  };
  renderAt('/admin/people', api);
  const panel = await lookUp(cook);
  const result = await within(panel).findByRole('region', { name: 'Lookup result' });
  fireEvent.click(within(result).getByRole('button', { name: `Delete ${cook}` }));
  confirmDelete(cook);
  expect(await screen.findByText(`Deleted ${cook}’s Townwise records.`)).toBeTruthy();
  expect(await within(panel).findByText('No one with that email has signed in or been added.')).toBeTruthy();
  expect(within(panel).queryByRole('region', { name: 'Lookup result' })).toBeNull();
  expect(lookups(api)).toHaveLength(2);
});

test('the lookup result reads again after a sign-out, and after a 404 that says the person is gone', async () => {
  const api = consoleApi();
  serve(api);
  const cook = emailOf('cook');
  let found: unknown = person(cook, 'signed_in', { userId: 'u7' });
  api.routes[lookupRoute(cook)] = () => ({ person: found });
  api.routes['POST /api/admin/people/u7/sign-out-everywhere'] = () => ({ revoked: 2 });
  renderAt('/admin/people', api);
  const panel = await lookUp(cook);
  fireEvent.click(within(await within(panel).findByRole('region', { name: 'Lookup result' })).getByRole('button', { name: `Sign out ${cook} everywhere` }));
  fireEvent.click(within(screen.getByRole('dialog', { name: `Sign out ${cook} everywhere?` })).getByRole('button', { name: 'Sign out everywhere' }));
  expect(await screen.findByText(`Signed ${cook} out everywhere.`)).toBeTruthy();
  await waitFor(() => { expect(lookups(api)).toHaveLength(2); });

  // Deleted elsewhere meanwhile: the page says so, and the lookup drops them.
  api.routes['POST /api/admin/people/u7/sign-out-everywhere'] = () => { found = null; return refusal(404, 'not_found'); };
  fireEvent.click(within(await within(panel).findByRole('region', { name: 'Lookup result' })).getByRole('button', { name: `Sign out ${cook} everywhere` }));
  const dialog = screen.getByRole('dialog', { name: `Sign out ${cook} everywhere?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
  const line = await screen.findByText('This person no longer exists.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement?.contains(line)).toBe(true);
  expect(await within(panel).findByText('No one with that email has signed in or been added.')).toBeTruthy();
  expect(within(panel).queryByRole('region', { name: 'Lookup result' })).toBeNull();
  expect(lookups(api)).toHaveLength(3);
});
