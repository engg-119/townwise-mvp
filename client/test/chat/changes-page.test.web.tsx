import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AGENT_AUTO_WORDS, changeLine, undoErrorText } from '../../src/chat/agentChanges';
import { CHANGES_INTRO } from '../../src/chat/ui/ChangesPage';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';

// D59: TownwiseAI's log of its changes (/locations/[locationId]/agent/changes) on web: every change, newest first,
// with what it was made from, its why, Undo while offered and the next page on demand. Under view-as it reads, with no
// why and no Undo. Slice 2: a calendar sorted on import is one line with how many events it labeled, and only an org
// admin may undo it. Slice 3: a business rule from the weekly look ahead or the sales history has its own line.
// Synthetic changes.

const LOG = '/api/org/locations/l1/agent/changes';

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void { /* nothing is laid out */ }
    unobserve(): void { /* nothing is laid out */ }
    disconnect(): void { /* nothing is laid out */ }
  };
}

afterEach(() => {
  cleanup();
  resetProfiles();
});

function change(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(n).padStart(24, '0'), at: `2026-06-0${String(n)}T10:00:00.000Z`, action: 'note.add', sourceKind: 'file', sourceRef: 'f_0123456789abcdef01234567',
    status: 'applied', startDate: '2026-07-04', endDate: '2026-07-04', noteKind: 'closure', why: `The file says closed ${String(n)}`,
    undoable: true, targetId: 'a'.repeat(24), ...over,
  };
}

function renderAt(api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  const role = me.access.state === 'member' ? me.access.role : 'member';
  const portal = fakePortalApi({ me, org: orgOf(role), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: ['a', 'example.com'].join('@') } }, { api: portal });
  const path = '/locations/l1/agent/changes';
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

test('lists every change with its why and Undo, and loads the next page on demand', async () => {
  const api = fakeChatApi();
  api.reads[LOG] = () => ({ changes: [change(3), change(2, { status: 'adopted', undoable: false })], next: '2026-06-02T10:00:00.000Z_000000000000000000000002' });
  api.reads[`${LOG}?before=${encodeURIComponent('2026-06-02T10:00:00.000Z_000000000000000000000002')}`] = () => ({
    changes: [change(1, { action: 'sales_days.add', noteKind: null, startDate: '2026-05-01', endDate: '2026-05-31', why: null })], next: null,
  });
  renderAt(api);
  const list = await screen.findByRole('list', { name: 'TownwiseAI’s changes' });
  expect(screen.getByRole('heading', { name: 'Every change it made on its own' })).toBeTruthy();
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(within(list).getByText('Why: The file says closed 3')).toBeTruthy();
  expect(within(list).getByText('Added a note: Closure, Jul 4, 2026, from a file you added. You changed it since, so it’s yours.')).toBeTruthy();
  expect(within(list).getAllByRole('button', { name: /^Undo: / })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
  expect(await within(list).findByText('Added sales days you didn’t have for May 1 to May 31, 2026, from a file you added.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show older changes' })).toBeNull();
});

test('under view-as it reads with no why and no Undo, and says nothing changed when there is nothing', async () => {
  const api = fakeChatApi();
  api.reads[LOG] = () => ({ changes: [change(1, { why: null, undoable: false })], next: null });
  renderAt(api, viewAsMe(ACCESS.member));
  const list = await screen.findByRole('list', { name: 'TownwiseAI’s changes' });
  expect(within(list).queryByText(/^Why:/)).toBeNull();
  expect(within(list).queryByRole('button', { name: /^Undo: / })).toBeNull();
  cleanup();
  const empty = fakeChatApi();
  empty.reads[LOG] = () => ({ changes: [], next: null });
  renderAt(empty);
  expect(await screen.findByText('TownwiseAI hasn’t changed anything here on its own yet.')).toBeTruthy();
});

test('slice 2: a calendar sorted on import is one line with its count and Undo, and a refusal says only an org admin can', async () => {
  const api = fakeChatApi();
  const id = '000000000000000000000002';
  let undone = false;
  api.reads[LOG] = () => ({
    changes: [
      change(2, {
        action: 'booking.label', sourceKind: 'calendar', sourceRef: null, noteKind: null, count: 12, startDate: '2025-07-12', endDate: '2026-06-20', why: null,
        ...(undone ? { status: 'undone', undoable: false } : {}),
      }),
      // An older API's answer has no count.
      change(1, { action: 'booking.label', sourceKind: 'calendar', sourceRef: null, noteKind: null, startDate: null, endDate: null, why: null, undoable: false }),
    ],
    next: null,
  });
  api.respond[`${LOG}/${id}/undo`] = () => {
    undone = true;
    return {
      change: change(2, { action: 'booking.label', sourceKind: 'calendar', sourceRef: null, noteKind: null, count: 12, startDate: '2025-07-12', endDate: '2026-06-20', why: null, status: 'undone', undoable: false }),
    };
  };
  renderAt(api, meOf(ACCESS.admin));
  const list = await screen.findByRole('list', { name: 'TownwiseAI’s changes' });
  const line = 'Added booking labels on 12 events, used for forecasts, from a calendar you imported.';
  expect(within(list).getByText(line)).toBeTruthy();
  expect(within(list).getByText('Added booking labels, used for forecasts, from a calendar you imported.')).toBeTruthy();
  fireEvent.click(within(list).getByRole('button', { name: `Undo: ${line}` }));
  expect(await screen.findByText(`${line} Undone.`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: `Undo: ${line}` })).toBeNull();
  expect(api.writes).toEqual([{ method: 'POST', path: `${LOG}/${id}/undo`, body: undefined }]);
  expect(undoErrorText(refusal(403, 'forbidden'), 'booking.label')).toBe('Only an org admin can undo booking labels.');
  expect(undoErrorText(refusal(409, 'changed_since'), 'booking.label'))
    .toBe('You changed this since, so it’s yours now. Delete it from Your calendars if you don’t want it.');
});

test('slice 2: Undo on a calendar’s labels reads the log again, so the notes it took back read undone too', async () => {
  const api = fakeChatApi();
  const id = '000000000000000000000002';
  const labelsOf = (status: string) => change(2, {
    action: 'booking.label', sourceKind: 'calendar', sourceRef: null, noteKind: null, count: 3, startDate: '2026-06-20', endDate: '2026-06-20', why: null,
    status, undoable: status === 'applied',
  });
  const noteOf = (status: string) => change(1, {
    sourceKind: 'calendar', sourceRef: null, noteKind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', why: null, status, undoable: status === 'applied',
  });
  let reads = 0;
  api.reads[LOG] = () => {
    reads += 1;
    return reads === 1 ? { changes: [labelsOf('applied'), noteOf('applied')], next: null } : { changes: [labelsOf('undone'), noteOf('undone')], next: null };
  };
  api.respond[`${LOG}/${id}/undo`] = () => ({ change: labelsOf('undone') });
  renderAt(api, meOf(ACCESS.admin));
  const list = await screen.findByRole('list', { name: 'TownwiseAI’s changes' });
  expect(screen.getByText(CHANGES_INTRO)).toBeTruthy();
  const note = 'Added a note: Private event, Jun 20, 2026, from a calendar you imported.';
  expect(within(list).getByRole('button', { name: `Undo: ${note}` })).toBeTruthy();
  fireEvent.click(within(list).getByRole('button', { name: 'Undo: Added booking labels on 3 events, used for forecasts, from a calendar you imported.' }));
  // The list is drawn again from the second read.
  expect(await screen.findByText(`${note} Undone.`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Undo: / })).toBeNull();
  expect(reads).toBe(2);
});

test('the log’s intro and the switch’s words name calendar labels, and the switch says when a calendar file is sorted', () => {
  expect(CHANGES_INTRO).toBe(
    'Each note, business rule, summary, set of sales days or set of booking labels TownwiseAI saved here, newest first. Undo removes what it added, as long as nobody changed it since. Undo on a calendar’s booking labels also removes the notes TownwiseAI made from that calendar and stops using its labels for forecasts. Once you change something it added, it’s yours.',
  );
  expect(AGENT_AUTO_WORDS).toBe(
    'Let TownwiseAI work on its own. It reads each file you add to Your data, sorts the bookings in each calendar file your team imports while sending your calendars’ titles is on, and saves what it’s sure of, such as a dated private event, so the forecast updates. Each week it also saves the suggestions it’s sure of, and days your sales history shows you’re closed, with at most 2 business rules a week, and a change to your calendars brings that forward. Each change shows here with Undo. Anything it isn’t sure of waits for you.',
  );
});

test('slice 3: a rule from the sales history or the weekly look ahead, and a weekly note, each have their own words', () => {
  const base = { count: null, status: 'applied' as const };
  expect(changeLine({ ...base, action: 'rule.add', sourceKind: 'sales', noteKind: 'closure', startDate: '2026-06-08', endDate: null }))
    .toBe('Added a business rule: Closure, from Jun 8, 2026, from your sales history.');
  expect(changeLine({ ...base, action: 'rule.add', sourceKind: 'weekly', noteKind: 'closure', startDate: '2026-07-04', endDate: '2026-07-04' }))
    .toBe('Added a business rule: Closure, Jul 4, 2026, from its weekly look ahead.');
  expect(changeLine({ ...base, action: 'note.add', sourceKind: 'weekly', noteKind: 'private_event', startDate: '2026-06-13', endDate: '2026-06-13', status: 'undone' }))
    .toBe('Added a note: Private event, Jun 13, 2026, from its weekly look ahead. Undone.');
  expect(undoErrorText(refusal(409, 'changed_since'), 'rule.add')).toBe('You changed this since, so it’s yours now. Delete it from Business rules if you don’t want it.');
});
