import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import { formatDate } from '../../../src/portal/format';
import type { Rule, RuleSchedule } from '../../../src/portal/rules/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, ADMIN_EMAIL, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { openMore } from '../../helpers/topBar';
import { manyRules, ruleOf, rulesFake, suggestionOf, type RulesFake } from './fakes';

// P29 Business rules on web (spec 16.3, 10.16): the lead, the add form, the list with who added each rule, inline
// edit and a confirmed delete, the errors in place, the 30 limit, view-as, loading and failure. The page lives
// under TownwiseAI in the top bar.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; these tests cover the desktop layout.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

afterEach(() => {
  cleanup();
});

const PATH = '/api/org/locations/l1/rules';
const RULES: Rule[] = [
  ruleOf('r1', 'Closed Mondays'),
  ruleOf('r2', 'Patio opens in May', { addedVia: 'townwise_ai', createdByEmail: EMAIL, createdAt: '2026-04-10T15:00:00.000Z' }),
  ruleOf('r3', 'Brunch only on weekends', { createdByEmail: 'Townwise staff', canEdit: false }),
  ruleOf('r4', 'Large parties call ahead', { createdByEmail: 'Deleted person', canEdit: false }),
];

function setup(
  me: MeResponse = meOf(ACCESS.member), rules: RulesFake['rules'] = RULES, suggested: RulesFake['suggested'] = [],
): { api: FakePortalApi; fake: RulesFake } {
  const fake = rulesFake(rules, suggested);
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
}

function renderAt(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest<HTMLElement>('[role="listitem"], li');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
}

function field(name = 'New rule'): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name });
}

/** A control that stays focusable under view-as: a <button> with aria-disabled, described by the read-only line. */
function expectReadOnly(control: HTMLElement, lineId: string): void {
  expect(control.tagName).toBe('BUTTON');
  expect(control.getAttribute('aria-disabled')).toBe('true');
  expect(control.hasAttribute('disabled')).toBe(false);
  expect(control.getAttribute('aria-describedby')).toBe(lineId);
  expect(document.getElementById(lineId)?.textContent).toBe('Read-only while viewing as gm@example.org.');
}

test('lists rules oldest first with who added them, and the lead says they never change the forecast', async () => {
  const { api } = setup();
  renderAt('/locations/l1/rules', api);
  expect(await screen.findByText('Closed Mondays')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Business rules' })).toBeTruthy();
  // The page is the top bar's Rules section, under More (D38).
  expect(within(openMore()).getByRole('link', { name: 'Rules' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'TownwiseAI' }).getAttribute('aria-current')).toBeNull();
  // Two locations, so the lead names this one. A rule changes the forecast only with a schedule, and the lead says which.
  expect(screen.getByText(
    'Standing facts about how Main Street Bar runs, like “Closed Mondays” or “Brunch only on weekends”. TownwiseAI reads them with '
    + 'every message you send. A rule changes Townwise’s forecast only when you give it a schedule under Change the forecast: a closure, '
    + 'a buyout or a private event with a guest count, on the days you choose. For one day that’s different, add a note.',
  )).toBeTruthy();
  expect(screen.queryByText(/suggests|offers to save/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Notes' }).getAttribute('href')).toBe('/locations/l1/notes');
  expect(screen.getByRole('link', { name: 'Ask TownwiseAI' }).getAttribute('href')).toBe('/locations/l1/agent');
  const list = screen.getByRole('list', { name: 'Business rules' });
  const order = ['Closed Mondays', 'Patio opens in May', 'Brunch only on weekends', 'Large parties call ahead'];
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(4);
  items.forEach((item, index) => { expect(item.textContent.startsWith(order[index] ?? '-')).toBe(true); });
  expect(screen.getByText('4 of 30')).toBeTruthy();
  expect(within(rowOf('Closed Mondays')).getByText(`Added by ${ADMIN_EMAIL}, ${formatDate('2026-03-02T15:00:00.000Z')}`)).toBeTruthy();
  expect(within(rowOf('Patio opens in May')).getByText(`Saved from TownwiseAI by ${EMAIL}, ${formatDate('2026-04-10T15:00:00.000Z')}`)).toBeTruthy();
  expect(within(rowOf('Brunch only on weekends')).getByText(/^Added by Townwise staff, /)).toBeTruthy();
  expect(within(rowOf('Large parties call ahead')).getByText(/^Added by a deleted person, /)).toBeTruthy();
  // Edit and Delete only where the API allows.
  expect(within(rowOf('Closed Mondays')).getByRole('button', { name: 'Edit “Closed Mondays”' })).toBeTruthy();
  expect(within(rowOf('Closed Mondays')).getByRole('button', { name: 'Delete “Closed Mondays”' })).toBeTruthy();
  expect(within(rowOf('Brunch only on weekends')).queryByRole('button')).toBeNull();
  // The field's helper keeps guest names out.
  expect(screen.getByText('One line, up to 200 characters. Leave out guest names.')).toBeTruthy();
  // A rule with no schedule says TownwiseAI reads it and the forecast doesn't change.
  expect(within(rowOf('Closed Mondays')).getByText('TownwiseAI reads this. It doesn’t change the forecast.')).toBeTruthy();
});

const CLOSED_MONDAYS: RuleSchedule = {
  kind: 'closure', startDate: '2027-01-05', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
};

function section(within_: HTMLElement = document.body): HTMLElement {
  return within(within_).getByRole('group', { name: 'Change the forecast' });
}

/** The row being edited, whose text is in its field. */
function editingRow(): HTMLElement {
  const row = field('Edit rule').closest<HTMLElement>('[role="listitem"], li');
  if (row === null) throw new Error('no row in edit');
  return row;
}

test('a rule added with a schedule changes the forecast; the section checks the note form’s rules before anything is sent', async () => {
  const { api } = setup();
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  expect(screen.queryByRole('group', { name: 'Change the forecast' })).toBeNull();
  expect(screen.getByText('Optional. Without it, TownwiseAI reads the rule and the forecast doesn’t change.')).toBeTruthy();
  fireEvent.change(field(), { target: { value: 'Closed Tuesdays in winter' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change the forecast' }));
  // The note form's fields, a closure by default, with an end that may stay empty for no end.
  const fields = section();
  expect(within(fields).getByRole('button', { name: 'Closure' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(fields).getByText('Leave it empty to keep it going.')).toBeTruthy();
  expect(within(fields).queryByLabelText('Details (optional)')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(within(fields).getByText('Enter the start date.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  fireEvent.change(within(fields).getByLabelText('Starts'), { target: { value: '2026-12-01' } });
  fireEvent.change(within(fields).getByLabelText('Ends (optional)'), { target: { value: '2027-03-31' } });
  fireEvent.click(within(fields).getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('Closed Tuesdays in winter')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: PATH, body: {
      text: 'Closed Tuesdays in winter',
      schedule: { kind: 'closure', startDate: '2026-12-01', endDate: '2027-03-31', weekdays: [2], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    },
  }]);
  // The form starts over: no text, the section closed.
  expect(field().value).toBe('');
  expect(screen.queryByRole('group', { name: 'Change the forecast' })).toBeNull();
  expect(within(rowOf('Closed Tuesdays in winter')).getByText('Changes the forecast: Closed on Tuesdays from 2026-12-01')).toBeTruthy();
});

test('Remove from the forecast closes the section, and a rule added then sends no schedule', async () => {
  const { api } = setup();
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  fireEvent.change(field(), { target: { value: 'Kitchen closes at 9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change the forecast' }));
  fireEvent.click(within(section()).getByRole('button', { name: 'Remove from the forecast' }));
  expect(screen.queryByRole('group', { name: 'Change the forecast' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('Kitchen closes at 9')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: PATH, body: { text: 'Kitchen closes at 9' } }]);
});

test('the pressed control goes, so focus moves: Change the forecast to the section’s heading, Remove from the forecast to the line under its button', async () => {
  const { api } = setup();
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  // Nothing takes focus on the page's first render.
  expect(document.activeElement).toBe(document.body);
  const open = screen.getByRole('button', { name: 'Change the forecast' });
  open.focus();
  fireEvent.click(open);
  const heading = document.activeElement;
  expect(heading?.textContent).toBe('Change the forecast');
  expect(section().contains(heading)).toBe(true);
  // Taken from script only: tabIndex -1 keeps it out of the tab order, so Tab goes on to the first field.
  expect(heading?.getAttribute('tabindex')).toBe('-1');
  fireEvent.click(within(section()).getByRole('button', { name: 'Remove from the forecast' }));
  expect(document.activeElement?.textContent).toBe('Optional. Without it, TownwiseAI reads the rule and the forecast doesn’t change.');
  // In a row's edit too.
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  fireEvent.click(within(editingRow()).getByRole('button', { name: 'Change the forecast' }));
  expect(section(editingRow()).contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.textContent).toBe('Change the forecast');
});

test('a rule opened for edit with its schedule, and a form that starts over after Add rule, move no focus', async () => {
  const scheduled = ruleOf('r1', 'Closed Mondays', { schedule: CLOSED_MONDAYS, scheduleSummary: 'Closed on Mondays from Jan 5, 2027' });
  const { api } = setup(meOf(ACCESS.member), [scheduled, ...RULES.slice(1)]);
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  const edit = screen.getByRole('button', { name: 'Edit “Closed Mondays”' });
  edit.focus();
  fireEvent.click(edit);
  expect(section(editingRow())).toBeTruthy();
  expect(section(editingRow()).contains(document.activeElement)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.change(field(), { target: { value: 'Kitchen closes at 9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change the forecast' }));
  fireEvent.change(within(section()).getByLabelText('Starts'), { target: { value: '2026-12-01' } });
  const add = screen.getByRole('button', { name: 'Add rule' });
  add.focus();
  fireEvent.click(add);
  expect(await screen.findByText('Kitchen closes at 9')).toBeTruthy();
  expect(document.activeElement).toBe(add);
});

test('editing a rule with a schedule opens its section filled in; removing it sends schedule null; adding one to a rule sends it', async () => {
  const scheduled = ruleOf('r1', 'Closed Mondays', { schedule: CLOSED_MONDAYS, scheduleSummary: 'Closed on Mondays from Jan 5, 2027' });
  const { api } = setup(meOf(ACCESS.member), [scheduled, ...RULES.slice(1)]);
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  expect(within(rowOf('Closed Mondays')).getByText('Changes the forecast: Closed on Mondays from Jan 5, 2027')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  const fields = section(editingRow());
  expect(within(fields).getByLabelText<HTMLInputElement>('Starts').value).toBe('2027-01-05');
  expect(within(fields).getByLabelText<HTMLInputElement>('Ends (optional)').value).toBe('');
  expect(within(fields).getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true');
  // Saved unchanged, the schedule goes as it was.
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api).at(-1)).toEqual({ method: 'PATCH', path: `${PATH}/r1`, body: { text: 'Closed Mondays', schedule: CLOSED_MONDAYS } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  fireEvent.click(within(section(editingRow())).getByRole('button', { name: 'Remove from the forecast' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => { expect(within(rowOf('Closed Mondays')).getByText('TownwiseAI reads this. It doesn’t change the forecast.')).toBeTruthy(); });
  expect(writes(api).at(-1)).toEqual({ method: 'PATCH', path: `${PATH}/r1`, body: { text: 'Closed Mondays', schedule: null } });

  // A rule with no schedule gets one from its edit.
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Patio opens in May”' }));
  const row = editingRow();
  fireEvent.click(within(row).getByRole('button', { name: 'Change the forecast' }));
  fireEvent.change(within(section(row)).getByLabelText('Starts'), { target: { value: '2027-05-01' } });
  fireEvent.click(within(section(row)).getByRole('button', { name: 'Private event' }));
  fireEvent.change(within(section(row)).getByLabelText('Expected guests (optional)'), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => { expect(within(rowOf('Patio opens in May')).getByText(/^Changes the forecast: /)).toBeTruthy(); });
  expect(writes(api).at(-1)).toEqual({
    method: 'PATCH', path: `${PATH}/r2`, body: {
      text: 'Patio opens in May',
      schedule: { kind: 'private_event', startDate: '2027-05-01', endDate: null, weekdays: null, effect: 'more_guests', expectedGuests: 40, startTime: null, endTime: null },
    },
  });
});

test('Every year (D46): the box makes Starts and Ends the first season, requires Ends, and an edit prefills it', async () => {
  const { api } = setup();
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  fireEvent.change(field(), { target: { value: 'Closed in winter' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change the forecast' }));
  const fields = section();
  const box = within(fields).getByRole<HTMLInputElement>('checkbox', { name: 'Every year' });
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(box.checked).toBe(true);
  const help = within(fields).getByText('Closes the same days every year from Starts on, until you delete the rule.');
  expect(box.getAttribute('aria-describedby')).toBe(help.id);
  // Ends is no longer optional.
  expect(within(fields).queryByLabelText('Ends (optional)')).toBeNull();
  fireEvent.change(within(fields).getByLabelText('Starts'), { target: { value: '2027-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(within(fields).getByText('Enter the season’s last day.')).toBeTruthy();
  fireEvent.change(within(fields).getByLabelText('Ends'), { target: { value: '2027-12-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(within(fields).getByText('Pick a season shorter than a year that doesn’t start or end on Feb 29.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  fireEvent.change(within(fields).getByLabelText('Ends'), { target: { value: '2027-03-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('Closed in winter')).toBeTruthy();
  const winter = {
    kind: 'closure', startDate: '2027-01-01', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
    season: { repeat: 'yearly', from: '01-01', to: '03-31' },
  };
  expect(writes(api)).toEqual([{ method: 'POST', path: PATH, body: { text: 'Closed in winter', schedule: winter } }]);

  // Its edit opens with the box checked and the first season filled in; saved unchanged, the same season goes.
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed in winter”' }));
  const editing = section(editingRow());
  expect(within(editing).getByRole<HTMLInputElement>('checkbox', { name: 'Every year' }).checked).toBe(true);
  expect(within(editing).getByLabelText<HTMLInputElement>('Starts').value).toBe('2027-01-01');
  expect(within(editing).getByLabelText<HTMLInputElement>('Ends').value).toBe('2027-03-31');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api).at(-1)).toEqual({ method: 'PATCH', path: `${PATH}/r101`, body: { text: 'Closed in winter', schedule: winter } });
});

test('adds a rule with Enter, edits one in place and deletes one after confirming', async () => {
  const { api, fake } = setup();
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');

  // The client's rule first: nothing is sent.
  fireEvent.change(field(), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(screen.getByText('Write the rule.')).toBeTruthy();
  fireEvent.change(field(), { target: { value: 'a'.repeat(185) } });
  expect(screen.getByText('185 of 200 characters')).toBeTruthy();
  fireEvent.change(field(), { target: { value: 'a'.repeat(201) } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(screen.getByText('Keep it to 200 characters.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  fireEvent.change(field(), { target: { value: '  Kitchen   closes at 9 ' } });
  expect(screen.queryByText(/of 200 characters/)).toBeNull();
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(await screen.findByText('Kitchen closes at 9')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: PATH, body: { text: 'Kitchen closes at 9' } }]);
  expect(field().value).toBe('');
  expect(screen.getByText('Added the rule.')).toBeTruthy();
  expect(screen.getByText('5 of 30')).toBeTruthy();
  expect(within(rowOf('Kitchen closes at 9')).getByText(`Added by ${EMAIL}, ${formatDate('2026-11-04T15:00:00.000Z')}`)).toBeTruthy();

  // Edit turns the row into the field; Cancel puts the text back.
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  expect(field('Edit rule').value).toBe('Closed Mondays');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('textbox', { name: 'Edit rule' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  fireEvent.change(field('Edit rule'), { target: { value: 'Closed Mondays and Tuesdays' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Closed Mondays and Tuesdays')).toBeTruthy();
  expect(screen.getByText('Saved.')).toBeTruthy();
  expect(writes(api).at(-1)).toEqual({ method: 'PATCH', path: `${PATH}/r1`, body: { text: 'Closed Mondays and Tuesdays' } });

  fireEvent.click(screen.getByRole('button', { name: 'Delete “Patio opens in May”' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this rule?' });
  expect(within(dialog).getByText('TownwiseAI stops reading it from your next message.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
  expect(await screen.findByText('Deleted the rule.')).toBeTruthy();
  expect(screen.queryByText('Patio opens in May')).toBeNull();
  expect(writes(api).at(-1)).toEqual({ method: 'DELETE', path: `${PATH}/r2`, body: undefined });
  expect(Array.isArray(fake.rules) ? fake.rules.map((rule) => rule.id) : null).toEqual(['r1', 'r3', 'r4', 'r101']);
});

test('shows rule_exists and rule_limit in place, and a 404 reloads; at 30 rules the form is disabled with the limit line', async () => {
  const { api, fake } = setup();
  fake.fail[`POST ${PATH}`] = () => refusal(409, 'rule_exists');
  fake.fail[`DELETE ${PATH}/r2`] = () => refusal(404, 'not_found');
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  fireEvent.change(field(), { target: { value: 'closed mondays' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('That rule is already saved.')).toBeTruthy();
  // The text stays, so it can be changed and sent again.
  expect(field().value).toBe('closed mondays');
  fake.fail[`POST ${PATH}`] = () => refusal(409, 'rule_limit');
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('This location has 30 rules, the most it can hold. Delete one to add another.')).toBeTruthy();

  // A rule another tab made a duplicate of: the edit stays open, with why.
  fake.fail[`PATCH ${PATH}/r1`] = () => refusal(409, 'rule_exists');
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  fireEvent.change(field('Edit rule'), { target: { value: 'Patio opens in may' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('That rule is already saved.')).toBeTruthy();
  expect(field('Edit rule').value).toBe('Patio opens in may');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));


  // A rule deleted elsewhere: the dialog closes, the page says so, and the list loads again.
  fake.rules = RULES.filter((rule) => rule.id !== 'r2');
  fireEvent.click(screen.getByRole('button', { name: 'Delete “Patio opens in May”' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this rule?' })).getByRole('button', { name: 'Delete rule' }));
  expect(await screen.findByText('This rule was deleted.')).toBeTruthy();
  await waitFor(() => { expect(screen.queryByText('Patio opens in May')).toBeNull(); });
  expect(screen.queryByRole('dialog')).toBeNull();

  cleanup();
  renderAt('/locations/l1/rules', setup(meOf(ACCESS.member), manyRules(30)).api);
  expect(await screen.findByText('30 of 30')).toBeTruthy();
  const limit = 'This location has 30 rules, the most it can hold. Delete one to add another.';
  const line = screen.getByText(limit);
  expect(field().getAttribute('aria-readonly')).toBe('true');
  expect(field().getAttribute('aria-describedby')).toContain(line.id);
  const add = screen.getByRole('button', { name: 'Add rule' });
  expect(add.getAttribute('aria-disabled')).toBe('true');
  expect(add.getAttribute('aria-describedby')).toBe(line.id);
});

test('a 403 forbidden on an edit shows its line on the edit form until the re-read of /api/me answers', async () => {
  const { api, fake } = setup();
  fake.fail[`PATCH ${PATH}/r1`] = () => refusal(403, 'forbidden');
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  const meReads = (): number => api.calls.filter((call) => call.method === 'GET' && call.path === '/api/me').length;
  const before = meReads();
  // Hold the re-read, so the line shows before the portal routes again.
  const held = deferred<MeResponse>();
  const me = api.me;
  api.me = held.promise as unknown as MeResponse;
  fireEvent.click(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }));
  fireEvent.change(field('Edit rule'), { target: { value: 'Closed Mondays and Tuesdays' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Only the person who added this rule or an org admin can change it.')).toBeTruthy();
  expect(field('Edit rule').value).toBe('Closed Mondays and Tuesdays');
  expect(meReads()).toBe(before + 1);
  // The re-read answers and the portal routes again (4.3), leaving the rules page and its edit.
  held.resolve(me as MeResponse);
  await waitFor(() => { expect(window.location.pathname).not.toBe('/locations/l1/rules'); });
  expect(screen.queryByRole('textbox', { name: 'Edit rule' })).toBeNull();
  expect(screen.queryByText('Only the person who added this rule or an org admin can change it.')).toBeNull();
});

test('with no rules the list says so', async () => {
  const { api } = setup(meOf(ACCESS.member), []);
  renderAt('/locations/l1/rules', api);
  expect(await screen.findByText('No business rules yet. Add one above.')).toBeTruthy();
  expect(screen.getByText('0 of 30')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add rule' }).getAttribute('aria-disabled')).toBeNull();
});

test('under view-as every write control is disabled and described by the read-only line', async () => {
  const { api } = setup(viewAsMe(ACCESS.admin));
  renderAt('/locations/l1/rules', api);
  await screen.findByText('Closed Mondays');
  expect(field().getAttribute('aria-readonly')).toBe('true');
  expect(field().getAttribute('aria-describedby')).toContain('rules-ro');
  expectReadOnly(screen.getByRole('button', { name: 'Add rule' }), 'rules-ro');
  expectReadOnly(screen.getByRole('button', { name: 'Change the forecast' }), 'rules-ro');
  expectReadOnly(screen.getByRole('button', { name: 'Edit “Closed Mondays”' }), 'rules-ro');
  expectReadOnly(screen.getByRole('button', { name: 'Delete “Closed Mondays”' }), 'rules-ro');
  fireEvent.click(screen.getByRole('button', { name: 'Delete “Closed Mondays”' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('loading shows one line; a load failure shows the network copy with Try again', async () => {
  const held = deferred<Rule[]>();
  const { api, fake } = setup(meOf(ACCESS.member), held.promise);
  renderAt('/locations/l1/rules', api);
  expect(await screen.findByText('Loading business rules')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'New rule' })).toBeNull();
  held.resolve(RULES);
  expect(await screen.findByText('Closed Mondays')).toBeTruthy();

  cleanup();
  fake.rules = offline();
  renderAt('/locations/l1/rules', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fake.rules = RULES;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Closed Mondays')).toBeTruthy();
});

describe('Suggested by TownwiseAI (D46)', () => {
  const DECIDE = '/api/org/locations/l1/agent/rule-suggestions';
  const MONDAYS = suggestionOf('0000000000000000000000d1', 'Closed on Mondays');
  const WINTER = suggestionOf('0000000000000000000000d2', 'Closed Jan 1 to Mar 31 every year', {
    schedule: { ...MONDAYS.schedule, weekdays: null, season: { repeat: 'yearly', from: '01-01', to: '03-31' } },
    scheduleSummary: 'Closed Jan 1 to Mar 31 every year, from Nov 17, 2026', file: null,
  });
  const SALES = suggestionOf('sales_weekday_2', 'Closed on Tuesdays', {
    source: 'sales', file: null, schedule: { ...MONDAYS.schedule, weekdays: [2] }, scheduleSummary: 'Closed on Tuesdays from Sep 9, 2026',
    evidence: { noSalesCount: 10, weekdayCount: 14, lastSalesDate: '2026-09-08' },
  });

  function group(): HTMLElement {
    return screen.getByRole('region', { name: 'Suggested by TownwiseAI' });
  }

  function cardOf(text: string): HTMLElement {
    const found = within(group()).getByRole('heading', { level: 3, name: text }).parentElement;
    if (found === null) throw new Error(`no card for ${text}`);
    return found;
  }

  test('the group sits above Add a rule, each card with what it does, where it came from, and Confirm, Edit and Dismiss', async () => {
    const { api } = setup(meOf(ACCESS.member), RULES, [MONDAYS, WINTER, SALES]);
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    expect(group().compareDocumentPosition(field()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group()).getByText('3 to decide')).toBeTruthy();
    expect(within(group()).getByText('TownwiseAI found these in your files and sales history. Each changes nothing until someone on your team confirms it.')).toBeTruthy();
    const mondays = cardOf('Closed on Mondays');
    expect(within(mondays).getByText('Changes the forecast: Closed on Mondays from Nov 17, 2026')).toBeTruthy();
    expect(within(mondays).getByRole('link', { name: 'From Hours.pdf' }).getAttribute('href')).toBe('/locations/l1/data/f_1');
    expect(within(cardOf('Closed Jan 1 to Mar 31 every year')).getByText('From a file you deleted')).toBeTruthy();
    expect(within(cardOf('Closed on Tuesdays')).getByText(`No sales on any Tuesday since ${formatDate('2026-09-08')}. In all, 10 of 14 Tuesdays had no sales.`)).toBeTruthy();
    for (const name of ['Confirm “Closed on Mondays”', 'Edit “Closed on Mondays”', 'Dismiss “Closed on Mondays”']) {
      expect(within(mondays).getByRole('button', { name })).toBeTruthy();
    }
    // The rules list is unchanged: a suggestion is not a rule.
    expect(screen.getByText('4 of 30')).toBeTruthy();
    // With none, there is no group.
    cleanup();
    renderAt('/locations/l1/rules', setup().api);
    await screen.findByText('Closed Mondays');
    expect(screen.queryByRole('region', { name: 'Suggested by TownwiseAI' })).toBeNull();
  });

  test('Confirm moves the rule into the list in place; Dismiss takes the card away; each says so', async () => {
    const { api } = setup(meOf(ACCESS.member), RULES, [MONDAYS, SALES]);
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Confirm “Closed on Mondays”' }));
    expect(await screen.findByText('Added the rule “Closed on Mondays”.')).toBeTruthy();
    expect(within(rowOf('Closed on Mondays')).getByText('Changes the forecast: Closed on Mondays from Nov 17, 2026')).toBeTruthy();
    expect(within(rowOf('Closed on Mondays')).getByText(/^Saved from TownwiseAI by /)).toBeTruthy();
    expect(screen.getByText('5 of 30')).toBeTruthy();
    expect(within(group()).getByText('1 to decide')).toBeTruthy();
    fireEvent.click(within(cardOf('Closed on Tuesdays')).getByRole('button', { name: 'Dismiss “Closed on Tuesdays”' }));
    expect(await screen.findByText('Dismissed. TownwiseAI won’t suggest it again.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Suggested by TownwiseAI' })).toBeNull();
    expect(writes(api)).toEqual([
      { method: 'POST', path: `${DECIDE}/0000000000000000000000d1/accept`, body: {} },
      { method: 'POST', path: `${DECIDE}/sales_weekday_2/dismiss`, body: {} },
    ]);
  });

  test('Edit opens the rule form filled in, Every year and all; Save confirms the edited rule; Cancel goes back to the card', async () => {
    const { api } = setup(meOf(ACCESS.member), RULES, [WINTER]);
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed Jan 1 to Mar 31 every year');
    fireEvent.click(within(cardOf('Closed Jan 1 to Mar 31 every year')).getByRole('button', { name: 'Edit “Closed Jan 1 to Mar 31 every year”' }));
    const form = group();
    expect(within(form).getByRole<HTMLInputElement>('textbox', { name: 'Edit rule' }).value).toBe('Closed Jan 1 to Mar 31 every year');
    const fields = section(form);
    expect(within(fields).getByRole<HTMLInputElement>('checkbox', { name: 'Every year' }).checked).toBe(true);
    expect(within(fields).getByLabelText<HTMLInputElement>('Starts').value).toBe('2027-01-01');
    expect(within(fields).getByLabelText<HTMLInputElement>('Ends').value).toBe('2027-03-31');
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(group()).getByRole('button', { name: 'Confirm “Closed Jan 1 to Mar 31 every year”' })).toBeTruthy();

    fireEvent.click(within(group()).getByRole('button', { name: 'Edit “Closed Jan 1 to Mar 31 every year”' }));
    fireEvent.change(within(group()).getByRole('textbox', { name: 'Edit rule' }), { target: { value: 'Closed all winter' } });
    fireEvent.change(within(section(group())).getByLabelText('Ends'), { target: { value: '2027-02-28' } });
    fireEvent.click(within(group()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Added the rule “Closed all winter”.')).toBeTruthy();
    expect(rowOf('Closed all winter')).toBeTruthy();
    expect(writes(api)).toEqual([{
      method: 'POST', path: `${DECIDE}/0000000000000000000000d2/accept`, body: {
        rule: {
          text: 'Closed all winter',
          schedule: {
            kind: 'closure', startDate: '2027-01-01', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null,
            endTime: null, season: { repeat: 'yearly', from: '01-01', to: '02-28' },
          },
        },
      },
    }]);
  });

  test('focus moves to the notice after Confirm, Dismiss, Edit’s Save, a 409 already_decided and a 404 (UI review S1)', async () => {
    const { api, fake } = setup(meOf(ACCESS.member), RULES, [MONDAYS, WINTER, SALES]);
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    // The notice's message list takes focus: its counter, then the line.
    const focusedOn = async (text: string): Promise<void> => {
      await waitFor(() => { expect(document.activeElement?.textContent).toBe(`01${text}`); });
    };
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Confirm “Closed on Mondays”' }));
    await focusedOn('Added the rule “Closed on Mondays”.');
    fireEvent.click(within(cardOf('Closed on Tuesdays')).getByRole('button', { name: 'Dismiss “Closed on Tuesdays”' }));
    await focusedOn('Dismissed. TownwiseAI won’t suggest it again.');
    fireEvent.click(within(cardOf('Closed Jan 1 to Mar 31 every year')).getByRole('button', { name: 'Edit “Closed Jan 1 to Mar 31 every year”' }));
    fireEvent.click(within(group()).getByRole('button', { name: 'Save' }));
    await focusedOn('Added the rule “Closed Jan 1 to Mar 31 every year”.');
    cleanup();

    const again = setup(meOf(ACCESS.member), RULES, [MONDAYS, SALES]);
    const stored = ruleOf('r900', 'Closed Tuesdays', { addedVia: 'townwise_ai' });
    again.fake.fail[`POST ${DECIDE}/sales_weekday_2/accept`] = () => new ApiError('http', 'x', { status: 409, code: 'already_decided', detail: { rule: stored } });
    again.fake.fail[`POST ${DECIDE}/0000000000000000000000d1/dismiss`] = () => refusal(404, 'not_found');
    renderAt('/locations/l1/rules', again.api);
    await screen.findByText('Closed on Mondays');
    fireEvent.click(within(cardOf('Closed on Tuesdays')).getByRole('button', { name: 'Confirm “Closed on Tuesdays”' }));
    await focusedOn('Already confirmed as: Closed Tuesdays');
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Dismiss “Closed on Mondays”' }));
    await focusedOn('That suggestion was already decided, or its dates have passed.');
    expect(fake.suggested).toHaveLength(0);
  });

  test('Edit puts focus in the Edit rule field, and Cancel puts it back on the card’s Edit (UI review S2)', async () => {
    const { api } = setup(meOf(ACCESS.member), RULES, [MONDAYS]);
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Edit “Closed on Mondays”' }));
    await waitFor(() => { expect(document.activeElement).toBe(within(group()).getByRole('textbox', { name: 'Edit rule' })); });
    fireEvent.click(within(group()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(document.activeElement).toBe(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Edit “Closed on Mondays”' })); });
  });

  test('a Dismiss a racing Confirm beat (answered accepted) says it was already confirmed (UI review S4)', async () => {
    const { api, fake } = setup(meOf(ACCESS.member), RULES, [MONDAYS]);
    const stored = ruleOf('0000000000000000000000d1', 'Closed on Mondays', { addedVia: 'townwise_ai' });
    fake.respond[`POST ${DECIDE}/0000000000000000000000d1/dismiss`] = () => ({ suggestion: { id: stored.id, status: 'accepted' }, rule: stored });
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Dismiss “Closed on Mondays”' }));
    expect(await screen.findByText('Already confirmed as: Closed on Mondays')).toBeTruthy();
    expect(screen.queryByText('Added the rule “Closed on Mondays”.')).toBeNull();
  });

  test('?suggestion= opens that card’s edit, as the panel’s Edit links to it', async () => {
    const { api } = setup(meOf(ACCESS.member), RULES, [MONDAYS, SALES]);
    renderAt('/locations/l1/rules?suggestion=sales_weekday_2', api);
    const edit = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Edit rule' });
    expect(edit.value).toBe('Closed on Tuesdays');
    expect(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Confirm “Closed on Mondays”' })).toBeTruthy();
  });

  test('refusals: the limit and a saved rule with the same words stay on the card; another tab’s Confirm moves its rule in', async () => {
    const unscheduled = ruleOf('r9', 'Closed on Mondays');
    const { api, fake } = setup(meOf(ACCESS.member), [...RULES, unscheduled], [MONDAYS, SALES]);
    fake.fail[`POST ${DECIDE}/0000000000000000000000d1/accept`] = () => refusal(409, 'rule_exists');
    fake.fail[`POST ${DECIDE}/sales_weekday_2/accept`] = () => refusal(409, 'rule_limit');
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Tuesdays');
    fireEvent.click(within(cardOf('Closed on Tuesdays')).getByRole('button', { name: 'Confirm “Closed on Tuesdays”' }));
    expect(await within(cardOf('Closed on Tuesdays')).findByText('This location has 30 rules, the most it can hold. Delete one to confirm this.')).toBeTruthy();
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Confirm “Closed on Mondays”' }));
    const mondays = cardOf('Closed on Mondays');
    expect(await within(mondays).findByText('A rule with these words is already saved. Edit that rule, or change these words with Edit.')).toBeTruthy();
    // Edit that rule opens the saved one's edit in the list.
    fireEvent.click(within(mondays).getByRole('button', { name: 'Edit that rule' }));
    expect(field('Edit rule').value).toBe('Closed on Mondays');
    expect(editingRow().closest('[role="list"]')?.getAttribute('aria-label')).toBe('Business rules');

    const stored = ruleOf('r900', 'Closed Tuesdays', { addedVia: 'townwise_ai' });
    fake.fail[`POST ${DECIDE}/sales_weekday_2/accept`] = () => new ApiError('http', 'x', { status: 409, code: 'already_decided', detail: { rule: stored } });
    fireEvent.click(within(cardOf('Closed on Tuesdays')).getByRole('button', { name: 'Confirm “Closed on Tuesdays”' }));
    expect(await screen.findByText('Already confirmed as: Closed Tuesdays')).toBeTruthy();
    expect(rowOf('Closed Tuesdays')).toBeTruthy();
  });

  test('a suggestion decided elsewhere (404) says so and loads the page again', async () => {
    const { api, fake } = setup(meOf(ACCESS.member), RULES, [MONDAYS]);
    fake.fail[`POST ${DECIDE}/0000000000000000000000d1/dismiss`] = () => refusal(404, 'not_found');
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    fake.suggested = [];
    fireEvent.click(within(cardOf('Closed on Mondays')).getByRole('button', { name: 'Dismiss “Closed on Mondays”' }));
    expect(await screen.findByText('That suggestion was already decided, or its dates have passed.')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('region', { name: 'Suggested by TownwiseAI' })).toBeNull(); });
  });

  test('under view-as Confirm, Edit and Dismiss stay in place, disabled and described by the read-only line', async () => {
    const { api } = setup(viewAsMe(ACCESS.member), RULES, [{ ...MONDAYS, canDecide: false, file: { ref: 'f_1', title: null } }]);
    renderAt('/locations/l1/rules', api);
    await screen.findByText('Closed on Mondays');
    const mondays = cardOf('Closed on Mondays');
    expect(within(mondays).getByRole('link', { name: 'From a file TownwiseAI read' })).toBeTruthy();
    for (const name of ['Confirm “Closed on Mondays”', 'Edit “Closed on Mondays”', 'Dismiss “Closed on Mondays”']) {
      const button = within(mondays).getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('aria-describedby')?.split(' ')).toContain('rules-ro');
      fireEvent.click(button);
    }
    expect(screen.queryByRole('textbox', { name: 'Edit rule' })).toBeNull();
    expect(writes(api)).toEqual([]);
  });
});
