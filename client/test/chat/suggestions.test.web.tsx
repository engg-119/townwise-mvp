import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { weeklyWords } from '../../src/chat/ui/SuggestionCard';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// TownwiseAI's weekly suggestions in P25's panel on web (openspec change weekly-forecast-suggestions): each card asks
// its question with TownwiseAI's why and the calendar entries it names; org admins get Accept and Dismiss and the
// switch's button, members see the cards and whether the switch is on, with neither; what a decision did stays on the
// card; a suggestion the server no longer has open reads the panel again. The fixture is the API's (agent-panel.json).

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; suggestions: unknown[]; weeklySuggestions: Record<string, boolean> };
};

const NOTE_HEADING = 'Closed on Sat, Jul 4, 2026?';
const RULE_HEADING = 'Add the rule “Private party after Commencement”?';
const SWITCH_WORDS = weeklyWords('Hanover');

// The composer measures itself; jsdom has no ResizeObserver, and nothing here lays anything out.
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

function chatApi(canChange: boolean): FakeChatApi {
  const api = fakeChatApi();
  api.panel = { ...fixture.panel, weeklySuggestions: { ...fixture.panel.weeklySuggestions, available: true, canChange } };
  return api;
}

function renderAt(api: FakeChatApi, me: MeResponse): void {
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

async function side(): Promise<HTMLElement> {
  const found = await screen.findByTestId('agent-side');
  await within(found).findByRole('heading', { name: 'Suggested for the next 3 months' });
  return found;
}

function card(scope: HTMLElement, heading: string): HTMLElement {
  const found = within(scope).getByRole('heading', { level: 3, name: heading }).parentElement;
  if (found === null) throw new Error(`no card for ${heading}`);
  return found;
}

test('members see each suggestion with its why and calendar entries, and whether the switch is on, with no buttons', async () => {
  renderAt(chatApi(false), meOf(ACCESS.member));
  const panel = await side();
  expect(within(panel).getByText('2 to decide')).toBeTruthy();
  const note = card(panel, NOTE_HEADING);
  expect(within(note).getByText('Independence Day is Sat, Jul 4, and you were closed on it last year.')).toBeTruthy();
  expect(within(note).getByText('Based on Independence Day (Sat, Jul 4, 2026).')).toBeTruthy();
  expect(within(note).getByText('An admin of your organization can accept or dismiss this.')).toBeTruthy();
  const rule = card(panel, RULE_HEADING);
  expect(within(rule).getByText('Adds 40 guests on Jun 14, 2026, 6 pm to 10 pm')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Accept' })).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Dismiss' })).toBeNull();
  expect(within(panel).getByText('Weekly suggestions are on.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Turn off weekly suggestions' })).toBeNull();
  expect(within(panel).getByText(SWITCH_WORDS, { exact: false })).toBeTruthy();
  expect(within(panel).getAllByRole('link', { name: 'Privacy' })[0]?.getAttribute('href')).toBe('/privacy');
});

test('an org admin accepts a note and dismisses a rule; each card then says what it did', async () => {
  const api = chatApi(true);
  const acceptPath = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c1/accept';
  const dismissPath = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c2/dismiss';
  api.respond[acceptPath] = () => ({ suggestion: { id: '0000000000000000000000c1', status: 'accepted' }, note: null, rule: null });
  api.respond[dismissPath] = () => ({ suggestion: { id: '0000000000000000000000c2', status: 'dismissed' }, note: null, rule: null });
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const note = card(panel, NOTE_HEADING);
  expect(within(note).getByText(/^Accept saves this note/)).toBeTruthy();
  fireEvent.click(within(note).getByRole('button', { name: 'Accept' }));
  expect(await within(note).findByText('Saved a note: Closure, Sat, Jul 4, 2026.')).toBeTruthy();
  const rule = card(panel, RULE_HEADING);
  fireEvent.click(within(rule).getByRole('button', { name: 'Dismiss' }));
  expect(await within(rule).findByText('Dismissed. TownwiseAI won’t suggest it again.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path.includes('/suggestions/'))).toEqual([
    { method: 'POST', path: acceptPath, body: {} }, { method: 'POST', path: dismissPath, body: {} },
  ]);
  expect(within(panel).getByText('0 to decide')).toBeTruthy();
  // The switch still answers after a decision.
  api.respond['/api/org/weekly-suggestions'] = () => ({ weeklySuggestions: { on: false } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off weekly suggestions' }));
  expect(await within(panel).findByText('Weekly suggestions are off.')).toBeTruthy();
});

test('an org admin turns weekly suggestions off and back on', async () => {
  const api = chatApi(true);
  api.respond['/api/org/weekly-suggestions'] = (body) => ({ weeklySuggestions: { on: (body as { on: boolean }).on } });
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off weekly suggestions' }));
  expect(await within(panel).findByText('Weekly suggestions are off.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn on weekly suggestions' }));
  expect(await within(panel).findByText('Weekly suggestions are on.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path === '/api/org/weekly-suggestions').map((write) => write.body)).toEqual([{ on: false }, { on: true }]);
});

test('a suggestion the server no longer has open reads the panel again; another refusal stays on its card', async () => {
  const api = chatApi(true);
  const acceptPath = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c1/accept';
  api.respond[acceptPath] = () => refusal(409, 'note_limit');
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  fireEvent.click(within(card(panel, NOTE_HEADING)).getByRole('button', { name: 'Accept' }));
  expect(await within(card(panel, NOTE_HEADING)).findByText('This location has 1,000 notes. Delete old ones to add more.')).toBeTruthy();
  const loads = api.panelLoads;
  api.respond[acceptPath] = () => refusal(404, 'not_found');
  fireEvent.click(within(card(panel, NOTE_HEADING)).getByRole('button', { name: 'Accept' }));
  await waitFor(() => { expect(api.panelLoads).toBeGreaterThan(loads); });
});

test('with none open, the section says so and still shows the switch', async () => {
  const api = chatApi(false);
  api.panel = { ...(api.panel as object), suggestions: [] };
  renderAt(api, meOf(ACCESS.member));
  const panel = await side();
  expect(within(panel).getByText('No suggestions right now.')).toBeTruthy();
  expect(within(panel).getByText('Weekly suggestions are on.')).toBeTruthy();
});

test('the header’s Questions and activity button counts open questions and open suggestions, as Home’s link does', async () => {
  // The fixture asks 3 questions and has 2 suggestions open: Home's link reads "5 questions from TownwiseAI".
  const api = chatApi(true);
  api.respond['/api/org/locations/l1/agent/suggestions/0000000000000000000000c2/dismiss'] = () => (
    { suggestion: { id: '0000000000000000000000c2', status: 'dismissed' }, note: null, rule: null }
  );
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  expect(screen.getByRole('button', { name: 'Questions and activity (5)' })).toBeTruthy();
  fireEvent.click(within(card(panel, RULE_HEADING)).getByRole('button', { name: 'Dismiss' }));
  expect(await screen.findByRole('button', { name: 'Questions and activity (4)' })).toBeTruthy();
});

test('while weekly passes aren’t running, the panel says only that, never that TownwiseAI is unavailable', async () => {
  const api = chatApi(false);
  api.panel = { ...(api.panel as object), weeklySuggestions: { on: true, available: false, canChange: false } };
  renderAt(api, meOf(ACCESS.member));
  const panel = await side();
  expect(within(panel).getByText('Weekly suggestions aren’t running right now, so none are being made.')).toBeTruthy();
  expect(within(panel).queryByText(/isn’t available here/)).toBeNull();
});
