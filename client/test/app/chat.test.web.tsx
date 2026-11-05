import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, PROPOSAL, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => {
  cleanup();
});

const EMAIL = ['a', 'example.com'].join('@');

// The portal answers GET /api/me and /api/org; the tuning chat's own routes go to its fake.
function renderAt(path: string, api: FakeChatApi): void {
  const portal = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: portal });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext(appRoutes(seededRoot(auth), {
          '(marketing)/index': () => null,
          '(gate)/sign-in': () => null,
          '(gate)/totp': () => null,
          '(gate)/auth/magic': () => null,
        }))}
        location={path}
      />
    </Head.Provider>,
  );
}

test('on web, the dashboard links to a location, whose Chat tab streams a reply with a proposal card', async () => {
  const api = fakeChatApi();
  renderAt('/dashboard', api);
  fireEvent.click(await screen.findByText('Main Street Bar'));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1'); });
  fireEvent.click(await screen.findByRole('link', { name: 'Chat' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/chat'); });
  // The location's page header names the location, once, as the page's only h1; the chat's list comes under it.
  expect(await screen.findAllByRole('heading', { name: 'Main Street Bar' })).toHaveLength(1);
  expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Main Street Bar']);
  expect(screen.getByRole('heading', { level: 2, name: 'Conversations' })).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Closed for the holidays' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  // A tick inside act, so the turn settling (a few promise hops after end) is inside it too.
  await act(() => new Promise((resolve) => {
    api.turns[0]?.emit('text', { delta: 'Here is a note.' });
    api.turns[0]?.emit('proposal', { proposal: PROPOSAL });
    api.turns[0]?.emit('done', { stopReason: 'end_turn', costUsd: 0 });
    api.turns[0]?.end();
    setTimeout(resolve, 0);
  }));
  expect(screen.getByText('Here is a note.')).toBeTruthy();
  expect(screen.getByText('December 24, 2026 to December 26, 2026')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
  expect(await screen.findByText('Note added.')).toBeTruthy();
  expect(within(document.body).getByRole('button', { name: 'Send' })).toBeTruthy();
});
