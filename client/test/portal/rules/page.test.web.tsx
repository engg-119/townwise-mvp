import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { formatDate } from '../../../src/portal/format';
import type { Rule } from '../../../src/portal/rules/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, ADMIN_EMAIL, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { manyRules, ruleOf, rulesFake, type RulesFake } from './fakes';

// P28 Business rules on web (spec 16.3, 10.16): the lead, the add form, the list with who added each rule, inline
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

function setup(me: MeResponse = meOf(ACCESS.member), rules: RulesFake['rules'] = RULES): { api: FakePortalApi; fake: RulesFake } {
  const fake = rulesFake(rules);
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
  // The page lives under TownwiseAI in the top bar.
  expect(screen.getByRole('link', { name: 'TownwiseAI' }).getAttribute('aria-current')).toBe('true');
  // Two locations, so the lead names this one. Rules never change the forecast; notes do, and the lead says which.
  expect(screen.getByText(
    'Standing facts about how Main Street Bar runs, like “Closed Mondays” or “Brunch only on weekends”. TownwiseAI reads them with '
    + 'every message you send. They never change Townwise’s forecast. For a day that’s different, add a note: a closure, a buyout or a '
    + 'private event with a guest count changes the forecast for its days.',
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
