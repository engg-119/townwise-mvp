import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { resetDrafts } from '../../src/chat/drafts';
import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { CONVERSATION, fakeChatApi, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// The ordering setup card in TownwiseAI on the web (spec D56): a shown propose_order_setup call draws a card that
// previews its suggestions against the live setup, links to Ordering setup with the card's ids, and can only be set
// aside. Every supplier and item here is synthetic.

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
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
});

const EMAIL = ['a', 'example.com'].join('@');
const CALL = 'toolu_order_setup_0001';
const REF = `f_${'a'.repeat(24)}`;
const CARD = `/api/org/locations/l1/chat/c2/order-proposals/${CALL}`;
const SETUP = '/api/org/locations/l1/orders/setup';

const SAVED = {
  version: 3,
  updatedAt: '2026-11-10T15:00:00.000Z',
  suppliers: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
  items: [{
    id: 'bbbbbbbbbbbbbbbbbbbbbbb1', name: 'Sample Lager', supplierId: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'bottles_cans', unit: 'cases',
    servingsPerUnit: 24, par: 2, dealSize: null, neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: 1 }],
  }],
};
const SETUP_ANSWER = { today: '2026-11-18', setup: SAVED, coverage: null, itemCoverage: {}, counts: {}, itemsWithHistory: [], canReadWithAi: true };

function item(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null, posNames: [], note: '',
    inFile: true, ...fields,
  };
}

const READ = {
  kind: 'order_guide', confidence: 'high', itemsCut: false, partial: false,
  suppliers: [{ name: 'New Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:00' }] }],
  items: [item('Sample Lager', { unit: 'kegs', servingsPerUnit: 124, servingsEstimated: true }), item('Sample Stout', { supplier: 'New Brewery', inFile: false })],
};

function open(over: Record<string, unknown> = {}): { proposal: Record<string, unknown> } {
  return { proposal: { kind: 'setup', status: 'open', read: READ, readWeb: false, ...over } };
}

function renderAt(path: string, api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  if (!('about' in api)) serveAbout(api);
  const portal = fakePortalApi({ me, org: orgOf('member'), fallback: api });
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

/** Events and the turn settling (a few promise hops after end) inside one act. */
async function stream(steps: () => void): Promise<void> {
  await act(() => new Promise((resolve) => {
    steps();
    setTimeout(resolve, 50);
  }));
}

function served(card: () => unknown = open): FakeChatApi {
  const api = fakeChatApi();
  api.reads[CARD] = card;
  api.reads[SETUP] = () => SETUP_ANSWER;
  return api;
}

const TOOL = { id: CALL, name: 'propose_order_setup', state: 'done', input: { ref: REF, supplierCount: 1, itemCount: 2 }, result: { shown: true, supplierCount: 1, itemCount: 2, notInFileCount: 1, partial: false } };

/** A turn that shows the card, up to its tool event; `finish` saves it. */
async function proposed(api: FakeChatApi, me?: MeResponse): Promise<{ finish: () => Promise<void> }> {
  renderAt('/locations/l1/agent', api, me);
  fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'Set up my orders from this guide' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  const live = api.turns[0];
  if (live === undefined) throw new Error('no turn');
  await stream(() => {
    live.emit('conversation', { id: 'c2', title: 'Orders' });
    live.emit('tool', TOOL);
  });
  return {
    finish: () => stream(() => {
      live.emit('done', { stopReason: 'end_turn', costUsd: 0 });
      live.end();
    }),
  };
}

const HEADLINE = 'TownwiseAI suggests 2 items: 1 new and 1 already in your setup by name.';

test('a shown propose_order_setup call waits while it streams, then draws the card with the merge preview once the turn is saved, and on reload', async () => {
  const api = served();
  const { finish } = await proposed(api);
  // Not saved yet: the card's GET would be 404, so nothing is asked, and a card is held until the reply ends.
  expect(screen.queryByText(HEADLINE)).toBeNull();
  expect(screen.queryByText('Ordering setup suggestions')).toBeNull();
  // The call itself is no row of the reply's work.
  expect(screen.queryByText(/ordering setup suggestions$/i)).toBeNull();
  await finish();
  expect(await screen.findByText(HEADLINE)).toBeTruthy();
  for (const line of [
    'Ordering setup suggestions',
    'An item already in your setup keeps its par, its never run out and its register names.',
    'New supplier: New Brewery (Tuesday).',
    'TownwiseAI estimated the servings per unit of 1 item.',
    'TownwiseAI didn’t find 1 of these names in the file.',
    'Nothing is saved yet. Review these in Ordering setup, set the par of the new item, and save there.',
    '1 item already in your setup would change:',
    'Sample Lager: unit cases to kegs; servings per unit 24 to 124',
  ]) expect(screen.getByText(line)).toBeTruthy();
  expect(screen.queryByText(/web pages/)).toBeNull();
  expect(api.writes).toEqual([]);
  cleanup();

  // On reload the stored call draws the same card.
  const stored = served();
  stored.reads['/api/org/locations/l1/chat/c1/order-proposals/' + CALL] = open;
  stored.conversation = {
    ...CONVERSATION,
    messages: [CONVERSATION.messages[0], {
      nodeId: 'a1', role: 'assistant', text: 'Here is what the guide lists.', proposals: [], at: '2026-11-02T14:59:01.000Z',
      parts: [{ type: 'text', text: 'Here is what the guide lists.' }, { type: 'tool', ...TOOL }],
    }],
  };
  renderAt('/locations/l1/agent', stored);
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
  expect(await screen.findByText(HEADLINE)).toBeTruthy();
  expect(screen.getByText('Here is what the guide lists.')).toBeTruthy();
});

test('Review links to Ordering setup with the card’s ids and no name', async () => {
  const api = served();
  await (await proposed(api)).finish();
  const review = await screen.findByRole('link', { name: 'Review in Ordering setup' });
  expect(review.getAttribute('href')).toBe(`/locations/l1/orders/setup?proposal=c2.${CALL}`);
});

test('Not now sets it aside', async () => {
  const api = served();
  api.respond[CARD] = () => ({ proposal: { kind: 'setup', status: 'dismissed' } });
  await (await proposed(api)).finish();
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  expect(await screen.findByText('Not now.')).toBeTruthy();
  expect(screen.queryByText(HEADLINE)).toBeNull();
  expect(api.writes.filter((write) => write.path === CARD)).toEqual([{ method: 'POST', path: CARD, body: { action: 'dismiss' } }]);
  cleanup();

  // A card read as set aside says so, and one whose suggestions are saved already offers nothing to do.
  const aside = served(() => open({ status: 'dismissed' }));
  await (await proposed(aside)).finish();
  expect(await screen.findByText('Not now.')).toBeTruthy();
  cleanup();
  const done = served(() => open({ read: { ...READ, suppliers: [], items: [item('Sample Lager')] } }));
  await (await proposed(done)).finish();
  expect(await screen.findByText('These suggestions are in your ordering setup.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
});

test('says so when the conversation also read web pages', async () => {
  const api = served(() => open({ readWeb: true }));
  await (await proposed(api)).finish();
  expect(await screen.findByText('This reply also read web pages, which Townwise didn’t check. Look over each change before you save.')).toBeTruthy();
});

test('a card whose file was turned off or deleted says it isn’t available', async () => {
  const api = served(() => new ApiError('http', 'The request was refused.', { status: 404, code: 'not_found' }));
  await (await proposed(api)).finish();
  expect(await screen.findByText('This proposal isn’t available.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  cleanup();

  // The setup itself failing to load says that, and offers nothing to open.
  const broken = served();
  broken.reads[SETUP] = () => new ApiError('network', 'The request failed.');
  await (await proposed(broken)).finish();
  expect(await screen.findByText('Townwise couldn’t load your ordering setup, so it can’t show what these suggestions would change. Reload the page to try again.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
});

test('no actions under view-as', async () => {
  const api = served();
  api.conversation = {
    ...CONVERSATION,
    messages: [CONVERSATION.messages[0], {
      nodeId: 'a1', role: 'assistant', text: '', proposals: [], at: '2026-11-02T14:59:01.000Z', parts: [{ type: 'tool', ...TOOL }],
    }],
  };
  api.reads['/api/org/locations/l1/chat/c1/order-proposals/' + CALL] = open;
  renderAt('/locations/l1/agent', api, viewAsMe(ACCESS.member));
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
  expect(await screen.findByText(HEADLINE)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
  expect(api.writes).toEqual([]);
});
