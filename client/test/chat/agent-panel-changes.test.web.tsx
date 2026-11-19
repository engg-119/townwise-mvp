import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, forgetLastChats, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// D59 (openspec change auto-apply-agent-reads) in P25's panel on web: a change TownwiseAI saved on its own is an
// activity line with Undo, which sends to the undo route and says Undone, or says the 409's words when a person changed
// it since; the waiting line counts what it wasn't sure of and links to the log; an event a file read wasn't sure of has
// Add the note and Dismiss; the switch sits after the weekly one, an org admin turns it, a member reads it; How
// TownwiseAI works says it saves what it's sure of only while the switch is on and it can run here. Undo stays offered
// after a failure worth retrying. Under view-as Undo is not offered. The fixture is the API's.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as { panel: Record<string, unknown> };
const CHANGE = '/api/org/locations/l1/agent/changes/0000000000000000000000e1/undo';

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
  forgetLastChats();
  resetProfiles();
  resetVersionFocus();
});

function chatApi(panel: Record<string, unknown> = fixture.panel): FakeChatApi {
  const api = fakeChatApi();
  api.panel = panel;
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

async function side(): Promise<HTMLElement> {
  const found = await screen.findByTestId('agent-side');
  await within(found).findByRole('heading', { name: 'What it’s been doing' });
  return found;
}

const LINE = 'Added a note: Private event, Jul 4, 2026, from a file you added.';

test('a change TownwiseAI saved shows in its activity with Undo, which sends to the undo route and says Undone', async () => {
  const api = chatApi();
  api.respond[CHANGE] = () => ({
    change: {
      id: '0000000000000000000000e1', at: '2026-06-01T08:00:00.000Z', action: 'note.add', sourceKind: 'file', sourceRef: null, status: 'undone',
      startDate: '2026-07-04', endDate: '2026-07-04', noteKind: 'private_event', why: null, undoable: false, targetId: null,
    },
  });
  renderAt(api);
  const panel = await side();
  expect(within(panel).getByText(LINE)).toBeTruthy();
  // Never a title or a why in the panel: the log has the why.
  expect(within(panel).queryByText(/Sentinel-why/)).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: `Undo: ${LINE}` }));
  expect(await within(panel).findByText(`${LINE} Undone.`)).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: `Undo: ${LINE}` })).toBeNull();
  expect(api.writes).toEqual([{ method: 'POST', path: CHANGE, body: undefined }]);
});

test('slice 2: Undo on a calendar’s labels reads the panel again, since it also took back that calendar’s notes', async () => {
  const labels = {
    at: '2026-06-01T08:00:00.000Z', kind: 'agent_change', changeId: '0000000000000000000000e1', action: 'booking.label', sourceKind: 'calendar',
    status: 'applied', startDate: '2026-07-04', endDate: '2026-07-04', noteKind: null, count: 3, undoable: true,
  };
  const api = chatApi({ ...fixture.panel, activity: [labels] });
  api.respond[CHANGE] = () => ({
    change: {
      id: '0000000000000000000000e1', at: '2026-06-01T08:00:00.000Z', action: 'booking.label', sourceKind: 'calendar', sourceRef: null, status: 'undone',
      startDate: '2026-07-04', endDate: '2026-07-04', noteKind: null, count: 3, why: null, undoable: false, targetId: null,
    },
  });
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const line = 'Added booking labels on 3 events, used for forecasts, from your calendar.';
  const loads = api.panelLoads;
  fireEvent.click(within(panel).getByRole('button', { name: `Undo: ${line}` }));
  await waitFor(() => { expect(api.panelLoads).toBe(loads + 1); });
});

test('Undo on a note a person changed since says it is theirs now, and where to delete it', async () => {
  const api = chatApi();
  api.respond[CHANGE] = () => refusal(409, 'changed_since');
  renderAt(api);
  const panel = await side();
  fireEvent.click(within(panel).getByRole('button', { name: `Undo: ${LINE}` }));
  expect(await within(panel).findByText('You changed this since, so it’s yours now. Delete it from Notes if you don’t want it.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: `Undo: ${LINE}` })).toBeNull();
});

test('slice 3: a weekday rule names its weekdays, and a member whose Undo finds it changed is told to ask an org admin', async () => {
  const rule = {
    at: '2026-06-01T08:00:00.000Z', kind: 'agent_change', changeId: '0000000000000000000000e1', action: 'rule.add', sourceKind: 'sales',
    status: 'applied', startDate: '2026-06-08', endDate: null, noteKind: 'closure', weekdays: [1], count: null, undoable: true,
  };
  const api = chatApi({ ...fixture.panel, activity: [rule] });
  api.respond[CHANGE] = () => refusal(409, 'changed_since');
  renderAt(api);
  const panel = await side();
  const line = 'Added a business rule: Closure on Mondays, from Jun 8, 2026, from your sales history.';
  fireEvent.click(within(panel).getByRole('button', { name: `Undo: ${line}` }));
  expect(await within(panel).findByText(
    'Someone changed this since, so it’s no longer TownwiseAI’s to undo. Ask an org admin to delete it from Business rules if you don’t want it.',
  )).toBeTruthy();
});

test('the waiting line counts what it wasn’t sure of and links to the log; an unsure event has Add the note and Dismiss', async () => {
  const api = chatApi();
  const base = '/api/org/locations/l1/agent/rule-suggestions/0000000000000000000000d2';
  api.respond[`${base}/accept`] = () => ({ suggestion: { id: '0000000000000000000000d2', status: 'accepted' }, note: null });
  renderAt(api);
  const panel = await side();
  expect(within(panel).getByText('3 things TownwiseAI wasn’t sure of are waiting for you.')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'Every change TownwiseAI made' }).getAttribute('href')).toBe('/locations/l1/agent/changes');
  const unsure = within(panel).getByText('Private event, Jul 11, 2026: Sentinel-unsure-event').parentElement;
  if (unsure === null) throw new Error('no card');
  expect(within(unsure).getByText('From Sentinel-file-name.csv.')).toBeTruthy();
  fireEvent.click(within(unsure).getByRole('button', { name: 'Add the note' }));
  expect(await within(unsure).findByText('Added to Notes.')).toBeTruthy();
  expect(api.writes).toEqual([{ method: 'POST', path: `${base}/accept`, body: {} }]);
});

const SAVES_ON = 'It saves what it’s sure of and shows each change here with Undo. Anything it isn’t sure of waits for you.';
const SAVES_OFF = 'It suggests notes; it saves one only when you ask, or when you let it read a file.';

test('the switch: an org admin turns it off, and How TownwiseAI works then says it saves only when asked', async () => {
  const api = chatApi({ ...fixture.panel, agentAuto: { on: true, available: true, canChange: true } });
  api.respond['/api/org/agent-auto'] = () => ({ agentAuto: { on: false } });
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  expect(within(panel).getByRole('heading', { name: 'Working on its own' })).toBeTruthy();
  expect(within(panel).getByText('TownwiseAI works on its own.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'How TownwiseAI works' }));
  expect(within(panel).getByText(SAVES_ON)).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off working on its own' }));
  expect(await within(panel).findByText('TownwiseAI works on its own is off.')).toBeTruthy();
  expect(api.writes).toEqual([{ method: 'PATCH', path: '/api/org/agent-auto', body: { on: false } }]);
  expect(within(panel).getByText(SAVES_OFF)).toBeTruthy();
  expect(within(panel).queryByText(SAVES_ON)).toBeNull();
});

test('where it can’t run (TOWNWISE_AGENT_AUTO off), the switch reads off and How TownwiseAI works never says it saves on its own', async () => {
  const api = chatApi({ ...fixture.panel, agentAuto: { on: true, available: false, canChange: false } });
  renderAt(api);
  const panel = await side();
  expect(within(panel).getByText('TownwiseAI works on its own is off.')).toBeTruthy();
  expect(within(panel).queryByText('TownwiseAI works on its own.')).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'How TownwiseAI works' }));
  expect(within(panel).getByText(SAVES_OFF)).toBeTruthy();
  expect(within(panel).queryByText(SAVES_ON)).toBeNull();
});

test('Undo that fails for a reason worth retrying says so and stays offered', async () => {
  const api = chatApi();
  let calls = 0;
  api.respond[CHANGE] = () => {
    calls += 1;
    return calls === 1 ? refusal(503, 'unavailable') : {
      change: {
        id: '0000000000000000000000e1', at: '2026-06-01T08:00:00.000Z', action: 'note.add', sourceKind: 'file', sourceRef: null, status: 'undone',
        startDate: '2026-07-04', endDate: '2026-07-04', noteKind: 'private_event', why: null, undoable: false, targetId: null,
      },
    };
  };
  renderAt(api);
  const panel = await side();
  fireEvent.click(within(panel).getByRole('button', { name: `Undo: ${LINE}` }));
  expect(await within(panel).findByText('Couldn’t undo this. Try again.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: `Undo: ${LINE}` }));
  expect(await within(panel).findByText(`${LINE} Undone.`)).toBeTruthy();
});

test('a member gets no switch button, and under view-as Undo is not offered and nothing is decided', async () => {
  const member = chatApi({ ...fixture.panel, agentAuto: { on: true, available: true, canChange: false } });
  renderAt(member);
  const panel = await side();
  expect(within(panel).getByText('TownwiseAI works on its own.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Turn off working on its own' })).toBeNull();
  cleanup();
  const activity = (fixture.panel.activity as Record<string, unknown>[]).map((item) => (item.kind === 'agent_change' ? { ...item, undoable: false } : item));
  const noteSuggestions = (fixture.panel.noteSuggestions as Record<string, unknown>[]).map((each) => ({ ...each, canDecide: false }));
  const viewing = chatApi({ ...fixture.panel, activity, noteSuggestions });
  renderAt(viewing, viewAsMe(ACCESS.member));
  const read = await side();
  expect(within(read).getByText(LINE)).toBeTruthy();
  expect(within(read).queryByRole('button', { name: `Undo: ${LINE}` })).toBeNull();
  const add = within(read).getByRole('button', { name: 'Add the note' });
  expect(add.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(add);
  await waitFor(() => { expect(viewing.writes).toEqual([]); });
});

// UI review 2026-11-19: the landing's line says what is true in both modes: while TownwiseAI works on its own it saves
// what it's sure of (D59, spec P25); while it doesn't, it suggests notes and the person decides.
const LANDING_AUTO = 'It saves what it’s sure of, each change with Undo in its activity; anything it isn’t sure of waits for you.';
const LANDING_OFF = 'It suggests notes; you decide what’s saved.';

/** The landing's one text element whose words end with `words`. */
function landingLine(words: string): (content: string, element: Element | null) => boolean {
  return (_content, element) => element !== null && element.children.length === 0 && element.textContent.startsWith('It reads') && element.textContent.endsWith(words);
}

test('the landing says TownwiseAI saves what it’s sure of while it works on its own, and suggests notes while it doesn’t', async () => {
  renderAt(chatApi({ ...fixture.panel, agentAuto: { on: true, available: true, canChange: false } }));
  await side();
  expect(await screen.findByText(landingLine(LANDING_AUTO))).toBeTruthy();
  expect(screen.queryByText(landingLine(LANDING_OFF))).toBeNull();
  cleanup();
  // Switched on but not running here: it reads nothing on its own, so the line is the one for off.
  renderAt(chatApi({ ...fixture.panel, agentAuto: { on: true, available: false, canChange: false } }));
  await side();
  expect(await screen.findByText(landingLine(LANDING_OFF))).toBeTruthy();
});
