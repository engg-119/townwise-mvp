import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { addDays, localToday } from '../../src/portal/locations/dates';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { CONVERSATION, fakeChatApi, forgetLastChats, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// D66 (openspec change town-research-agent, design decision 12, task 7.4): a correct_calendar_event call in a reply is
// its correction card, drawn from the existing `tool` part, live and on reload. A correction TownwiseAI made has Undo
// through the change's own route; one it proposed in a conversation that read the web has Apply, which reads the
// event's head fresh and sends the person's own PATCH. Under view-as neither writes. Made-up titles and places only.

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void { /* jsdom lays nothing out */ }
    unobserve(): void { /* jsdom lays nothing out */ }
    disconnect(): void { /* jsdom lays nothing out */ }
  };
}
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1280 });

afterEach(() => {
  cleanup();
  forgetLastChats();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
});

const BASE = '/api/org/locations/l1';
const EVENT_ID = `l-${'a'.repeat(24)}`;
const CHANGE_ID = '0000000000000000000000e5';
const UNDO = `${BASE}/agent/changes/${CHANGE_ID}/undo`;
const PATCH = `${BASE}/research/events/${EVENT_ID}`;

const APPLIED = {
  id: 'toolu_fix_1', name: 'correct_calendar_event', state: 'done', input: { eventId: EVENT_ID, change: 'hide' },
  result: { applied: true, code: null, eventId: EVENT_ID, changeId: CHANGE_ID, proposed: null },
};
const PROPOSED = {
  id: 'toolu_fix_2', name: 'correct_calendar_event', state: 'done', input: { eventId: EVENT_ID, change: 'edit' },
  result: { applied: false, code: 'needs_tap', eventId: EVENT_ID, changeId: null, proposed: { change: 'edit', fields: { start: '2026-12-10', end: '2026-12-10' } } },
};

function found(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID, head: 'r3', title: 'Trivia night', start: '2026-12-03', end: '2026-12-03', weekdays: null, startTime: '19:00',
    kind: 'event', category: 'dining', status: 'scheduled', origin: 'neighborhood', confidence: 'medium', where: 'Example Hall',
    who: null, competitor: null, sources: [], lastSeenAt: '2026-11-18T12:00:00.000Z', edited: false, hidden: false, ...fields,
  };
}

function calendarPath(): string {
  const today = localToday();
  return `${BASE}/calendar?from=${addDays(today, -365)}&to=${addDays(today, 395)}`;
}

function renderAt(api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  serveAbout(api);
  const portal = fakePortalApi({ me, org: orgOf('member'), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: ['a', 'example.com'].join('@') } }, { api: portal });
  window.history.replaceState(null, '', '/locations/l1/agent');
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext(appRoutes(seededRoot(auth), {
          '(marketing)/index': () => null, '(gate)/sign-in': () => null, '(gate)/totp': () => null, '(gate)/auth/magic': () => null,
        }))}
        location="/locations/l1/agent"
      />
    </Head.Provider>,
  );
}

/** A stored conversation whose reply holds `parts`, opened from History. */
async function openStored(api: FakeChatApi, parts: unknown[], me?: MeResponse): Promise<void> {
  api.conversation = {
    ...CONVERSATION,
    messages: [CONVERSATION.messages[0], {
      nodeId: 'a1', role: 'assistant', text: 'Done.', proposals: [], at: '2026-11-02T14:59:01.000Z', parts: [{ type: 'text', text: 'Done.' }, ...parts],
    }],
  };
  renderAt(api, me);
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
}

async function card(): Promise<HTMLElement> {
  return screen.findByRole('group', { name: 'Calendar correction' });
}

test('live: a correction TownwiseAI made is its card once the reply ends, and Undo sends to the change’s undo route', async () => {
  const api = fakeChatApi();
  api.respond[UNDO] = () => ({
    change: {
      id: CHANGE_ID, at: '2026-11-19T15:00:00.000Z', action: 'event.correct', sourceKind: 'chat', sourceRef: null, status: 'undone',
      startDate: null, endDate: null, noteKind: null, why: null, undoable: false, targetId: null,
    },
  });
  renderAt(api);
  fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'Hide the trivia night, it was cancelled' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  const live = api.turns[0];
  if (live === undefined) throw new Error('no turn');
  await act(() => new Promise((resolve) => {
    live.emit('conversation', { id: 'c2', title: 'Trivia' });
    live.emit('tool', { ...APPLIED, state: 'running', result: null });
    live.emit('tool', APPLIED);
    setTimeout(resolve, 50);
  }));
  // Held until the reply ends, as every card is.
  expect(screen.queryByRole('group', { name: 'Calendar correction' })).toBeNull();
  await act(() => new Promise((resolve) => {
    live.emit('done', { stopReason: 'end_turn', costUsd: 0 });
    live.end();
    setTimeout(resolve, 50);
  }));
  const shown = await card();
  expect(within(shown).getByText('TownwiseAI hid an event town research found, on this location’s calendar only.')).toBeTruthy();
  expect(within(shown).getByRole('link', { name: 'Open the Calendar' }).getAttribute('href')).toBe('/locations/l1/calendar');
  // The call is the card, not also a row of the reply's work.
  expect(screen.queryByText(/an event on the calendar$/)).toBeNull();
  fireEvent.click(within(shown).getByRole('button', { name: 'Undo' }));
  expect(await within(shown).findByText('Undone. The event reads as it did before.')).toBeTruthy();
  expect(within(shown).queryByRole('button', { name: 'Undo' })).toBeNull();
  expect(api.writes.filter((write) => write.path === UNDO)).toEqual([{ method: 'POST', path: UNDO, body: undefined }]);
});

test('on reload: Undo refused because someone edited the event since says so and is no longer offered', async () => {
  const api = fakeChatApi();
  api.respond[UNDO] = () => refusal(409, 'changed_since');
  await openStored(api, [{ type: 'tool', ...APPLIED }]);
  const shown = await card();
  fireEvent.click(within(shown).getByRole('button', { name: 'Undo' }));
  expect(await within(shown).findByText('Someone changed this event since, so it’s no longer TownwiseAI’s to undo. Change it on the Calendar.')).toBeTruthy();
  expect(within(shown).queryByRole('button', { name: 'Undo' })).toBeNull();
});

test('a proposal shows the change and why it waits; Apply sends the person’s own edit on the head read now', async () => {
  const api = fakeChatApi();
  api.reads[calendarPath()] = () => ({ town: { name: 'Hanover', state: 'NH', townId: 'hanover-nh' }, researched: true, covers: null, events: [], found: [found()] });
  api.respond[PATCH] = () => ({ event: found({ head: 'r4', start: '2026-12-10', end: '2026-12-10', edited: true }) });
  await openStored(api, [{ type: 'tool', ...PROPOSED }]);
  const shown = await card();
  expect(within(shown).getByText('TownwiseAI suggests changing an event town research found.')).toBeTruthy();
  expect(within(shown).getByText('Dates: Dec 10, 2026')).toBeTruthy();
  expect(within(shown).getByText('This conversation read a web page or a file, so nothing changes until you apply it. It changes this location’s calendar only.')).toBeTruthy();
  fireEvent.click(within(shown).getByRole('button', { name: 'Apply' }));
  expect(await within(shown).findByText('Applied. Only this location’s calendar changed. Reset it on the Calendar to undo.')).toBeTruthy();
  expect(within(shown).queryByRole('button', { name: 'Apply' })).toBeNull();
  expect(api.writes).toEqual([{ method: 'PATCH', path: PATCH, body: { op: 'edit', fields: { start: '2026-12-10', end: '2026-12-10' }, basedOn: 'r3' } }]);
});

test('Apply refused: too many edits is said in words, and Apply stays to try again', async () => {
  const api = fakeChatApi();
  api.reads[calendarPath()] = () => ({ town: { name: 'Hanover', state: 'NH', townId: 'hanover-nh' }, researched: true, covers: null, events: [], found: [found()] });
  api.respond[PATCH] = () => refusal(409, 'too_many_edits');
  await openStored(api, [{ type: 'tool', ...PROPOSED }]);
  const shown = await card();
  fireEvent.click(within(shown).getByRole('button', { name: 'Apply' }));
  expect(await within(shown).findByText('This location has reached its limit of 1,000 edits to researched events.')).toBeTruthy();
  expect(within(shown).getByRole('button', { name: 'Apply' })).toBeTruthy();
});

test('under view-as the card reads, and Undo and Apply are disabled', async () => {
  const api = fakeChatApi();
  await openStored(api, [{ type: 'tool', ...APPLIED }, { type: 'tool', ...PROPOSED }], viewAsMe(ACCESS.member));
  await waitFor(() => { expect(screen.getAllByRole('group', { name: 'Calendar correction' })).toHaveLength(2); });
  expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('button', { name: 'Apply' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(api.writes).toEqual([]);
});
