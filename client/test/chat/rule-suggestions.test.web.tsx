import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { resetDrafts } from '../../src/chat/drafts';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// Suggested closure rules in P25's panel on web (D46): a "Suggested rules" section first, with a card per suggestion
// from a file or the sales history. Any member confirms or dismisses one, and Edit links to P29's form; what a decision
// did stays on the card; a refusal shows on it; a suggestion the server no longer has reads the panel again. Under
// view-as the buttons stay in place, disabled. The fixture is the API's (agent-panel.json).

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; ruleSuggestions: unknown[] };
};
const BASE = '/api/org/locations/l1/agent/rule-suggestions';

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void { /* nothing is laid out */ }
    unobserve(): void { /* nothing is laid out */ }
    disconnect(): void { /* nothing is laid out */ }
  };
}

Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1280 });

afterEach(() => {
  cleanup();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
});

function chatApi(): FakeChatApi {
  const api = fakeChatApi();
  api.panel = fixture.panel;
  return api;
}

function renderAt(api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  serveAbout(api);
  const role = me.access.state === 'member' ? me.access.role : 'member';
  const portal = fakePortalApi({ me, org: orgOf(role), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: ['a', 'example.com'].join('@') } }, { api: portal });
  const path = '/locations/l1/agent?panel=questions';
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext(appRoutes(seededRoot(auth), {
          '(marketing)/index': () => null, '(gate)/sign-in': () => null, '(gate)/totp': () => null, '(gate)/auth/magic': () => null,
        }))}
        location={path}
      />
    </Head.Provider>,
  );
}

async function section(): Promise<HTMLElement> {
  const side = await screen.findByTestId('agent-side');
  const heading = await within(side).findByRole('heading', { name: 'Suggested rules' });
  const found = heading.parentElement?.parentElement;
  if (found === null || found === undefined) throw new Error('no section');
  return found;
}

function card(scope: HTMLElement, text: string): HTMLElement {
  const found = within(scope).getByRole('heading', { level: 3, name: text }).parentElement;
  if (found === null) throw new Error(`no card for ${text}`);
  return found;
}

test('the section comes first, and each card says the rule, what it does and where it came from', async () => {
  renderAt(chatApi());
  const rules = await section();
  const side = screen.getByTestId('agent-side');
  expect(within(side).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
  expect(within(rules).getByText('2 to decide')).toBeTruthy();
  const file = card(rules, 'Closed on Tuesdays');
  expect(within(file).getByText('Changes the forecast: Closed on Tuesdays from Jun 1, 2026')).toBeTruthy();
  expect(within(file).getByRole('link', { name: 'From Sentinel-file-name.csv' }).getAttribute('href')).toBe('/locations/l1/data/f_0000000000000000000000f1');
  const sales = card(rules, 'Closed on Mondays');
  expect(within(sales).getByText('In your sales history, 13 of 13 Mondays had no sales.')).toBeTruthy();
  // Edit is P29's form.
  expect(within(sales).getByRole('link', { name: 'Edit “Closed on Mondays”' }).getAttribute('href')).toBe('/locations/l1/rules?suggestion=sales_weekday_1');
  const confirm = within(sales).getByRole('button', { name: 'Confirm “Closed on Mondays”' });
  const help = within(sales).getByText('Confirm saves it as a business rule, and the forecast uses its schedule from then on. Edit changes it first. Dismiss and TownwiseAI won’t suggest it again.');
  expect(confirm.getAttribute('aria-describedby')).toBe(help.id);
  expect(within(sales).getByRole('group', { name: 'Closed on Mondays' })).toBeTruthy();
});

test('Confirm and Dismiss send to the suggested rules’ routes, the card says what they did, and the counts follow', async () => {
  const api = chatApi();
  api.respond[`${BASE}/sales_weekday_1/accept`] = () => ({ suggestion: { id: 'n1', status: 'accepted' }, rule: null });
  api.respond[`${BASE}/0000000000000000000000d1/dismiss`] = () => ({ suggestion: { id: '0000000000000000000000d1', status: 'dismissed' }, rule: null });
  renderAt(api);
  const rules = await section();
  expect(screen.getByRole('button', { name: 'Questions and activity (6)' })).toBeTruthy();
  fireEvent.click(within(card(rules, 'Closed on Mondays')).getByRole('button', { name: 'Confirm “Closed on Mondays”' }));
  const done = await within(rules).findByText('Added the business rule “Closed on Mondays”.');
  await waitFor(() => { expect(document.activeElement).toBe(done.parentElement); });
  expect(within(rules).getByText('1 to decide')).toBeTruthy();
  fireEvent.click(within(card(rules, 'Closed on Tuesdays')).getByRole('button', { name: 'Dismiss “Closed on Tuesdays”' }));
  expect(await within(rules).findByText('Dismissed. TownwiseAI won’t suggest it again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Questions and activity (4)' })).toBeTruthy();
  expect(api.writes).toEqual([
    { method: 'POST', path: `${BASE}/sales_weekday_1/accept`, body: {} },
    { method: 'POST', path: `${BASE}/0000000000000000000000d1/dismiss`, body: {} },
  ]);
});

test('refusals show on the card: the 30-rule limit, a saved rule with the same words, and a Confirm another tab won', async () => {
  const api = chatApi();
  api.respond[`${BASE}/sales_weekday_1/accept`] = () => refusal(409, 'rule_limit');
  api.respond[`${BASE}/0000000000000000000000d1/accept`] = () => refusal(409, 'rule_exists');
  renderAt(api);
  const rules = await section();
  fireEvent.click(within(card(rules, 'Closed on Mondays')).getByRole('button', { name: 'Confirm “Closed on Mondays”' }));
  expect(await within(rules).findByText('This location has 30 rules, the most it can hold. Delete one to confirm this.')).toBeTruthy();
  fireEvent.click(within(card(rules, 'Closed on Tuesdays')).getByRole('button', { name: 'Confirm “Closed on Tuesdays”' }));
  const tuesdays = card(rules, 'Closed on Tuesdays');
  expect(await within(tuesdays).findByText('A rule with these words is saved without a schedule. Add the schedule to it on Business rules.')).toBeTruthy();
  expect(within(tuesdays).getByRole('link', { name: 'Open Business rules' }).getAttribute('href')).toBe('/locations/l1/rules');
  // The suggestion stays open: Confirm is offered again.
  const stored = {
    id: '0000000000000000000000d1', text: 'Closed Tuesdays', addedVia: 'townwise_ai', createdByEmail: 'b@example.com',
    createdAt: '2026-11-17T15:00:00.000Z', updatedAt: '2026-11-17T15:00:00.000Z', canEdit: true,
  };
  api.respond[`${BASE}/0000000000000000000000d1/accept`] = () => new ApiError('http', 'x', { status: 409, code: 'already_decided', detail: { rule: stored } });
  fireEvent.click(within(tuesdays).getByRole('button', { name: 'Confirm “Closed on Tuesdays”' }));
  expect(await within(rules).findByText('Already confirmed as: Closed Tuesdays')).toBeTruthy();
});

test('a suggestion the server no longer has reads the panel again', async () => {
  const api = chatApi();
  api.respond[`${BASE}/sales_weekday_1/dismiss`] = () => refusal(404, 'not_found');
  renderAt(api);
  const rules = await section();
  const loads = api.panelLoads;
  fireEvent.click(within(card(rules, 'Closed on Mondays')).getByRole('button', { name: 'Dismiss “Closed on Mondays”' }));
  await waitFor(() => { expect(api.panelLoads).toBe(loads + 1); });
});

test('under view-as the buttons stay in place, disabled and described by the read-only line, and Edit goes nowhere', async () => {
  const api = chatApi();
  api.panel = { ...fixture.panel, ruleSuggestions: fixture.panel.ruleSuggestions.map((each) => ({ ...(each as object), canDecide: false })) };
  renderAt(api, viewAsMe(ACCESS.member));
  const rules = await section();
  const sales = card(rules, 'Closed on Mondays');
  for (const name of ['Confirm “Closed on Mondays”', 'Edit “Closed on Mondays”', 'Dismiss “Closed on Mondays”']) {
    const button = within(sales).getByRole('button', { name });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const ids = button.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('Read-only while viewing as gm@example.org.');
    fireEvent.click(button);
  }
  expect(within(sales).queryByRole('link', { name: 'Edit “Closed on Mondays”' })).toBeNull();
  expect(api.writes).toEqual([]);
});
