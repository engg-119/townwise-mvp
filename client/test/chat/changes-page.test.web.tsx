import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';

// D59: TownwiseAI's log of its changes (/locations/[locationId]/agent/changes) on web: every change, newest first,
// with what it was made from, its why, Undo while offered and the next page on demand. Under view-as it reads, with no
// why and no Undo. Synthetic changes.

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
