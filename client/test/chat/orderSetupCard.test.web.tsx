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
    'An item already in your setup by name keeps its par, never run out and point-of-sale names.',
    'New supplier: New Brewery (Tuesday).',
    'TownwiseAI estimated the servings per unit of 1 item.',
    'TownwiseAI didn’t find 1 of these names in the file.',
    'Nothing is saved yet. Review these in Ordering setup, set the par of the new item, and save there.',
    '1 item already in your setup by name would change:',
    'Sample Lager: unit: “cases” becomes “kegs”; servings per unit: “24” becomes “124”',
  ]) expect(screen.getByText(line)).toBeTruthy();
  expect(screen.queryByText(/web pages/)).toBeNull();
  expect(api.writes).toEqual([]);
  // UI review 4: "Nothing is saved yet" is the last line, directly above the actions.
  const closing = screen.getByText('Nothing is saved yet. Review these in Ordering setup, set the par of the new item, and save there.');
  const lines = [HEADLINE, '1 item already in your setup by name would change:', 'TownwiseAI didn’t find 1 of these names in the file.'].map((line) => screen.getByText(line));
  for (const line of lines) expect(line.compareDocumentPosition(closing) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(closing.compareDocumentPosition(screen.getByRole('link', { name: 'Review in Ordering setup' })) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
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
  // UI review 3: set aside is final, so the line says so and how to get the suggestions back; it is announced and
  // takes the focus the pressed button gave up.
  const aside = await screen.findByText('Set aside. Nothing was added. Ask TownwiseAI again if you want these suggestions back.');
  const status = aside.closest('[role="status"]');
  expect(status).not.toBeNull();
  await waitFor(() => { expect(document.activeElement).toBe(status); });
  expect(screen.queryByText('Not now.')).toBeNull();
  expect(screen.queryByText(HEADLINE)).toBeNull();
  expect(api.writes.filter((write) => write.path === CARD)).toEqual([{ method: 'POST', path: CARD, body: { action: 'dismiss' } }]);
  cleanup();

  // A card read as set aside says so, and one whose suggestions are saved already offers nothing to do.
  const earlier = served(() => open({ status: 'dismissed' }));
  await (await proposed(earlier)).finish();
  expect(await screen.findByText('Set aside. Nothing was added. Ask TownwiseAI again if you want these suggestions back.')).toBeTruthy();
  cleanup();
  const done = served(() => open({ read: { ...READ, suppliers: [], items: [item('Sample Lager')] } }));
  await (await proposed(done)).finish();
  expect(await screen.findByText('These suggestions are in your ordering setup.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
});

// Code review S1: the file was turned off or deleted after the card loaded.
test('Not now on a card that is no longer served says so and drops the actions', async () => {
  const api = served();
  api.respond[CARD] = () => new ApiError('http', 'The request was refused.', { status: 404, code: 'not_found' });
  await (await proposed(api)).finish();
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  expect(await screen.findByText('These suggestions aren’t available any more. The file they came from may have been turned off or deleted.')).toBeTruthy();
  expect(screen.queryByText('That didn’t go through. Try again.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  expect(screen.queryByText(HEADLINE)).toBeNull();
});

// Code review S4: a setup card has its own words while it loads.
test('while it loads, a setup card says it is loading TownwiseAI’s suggestions, not an order', async () => {
  let answer: (value: unknown) => void = () => undefined;
  const api = served(() => new Promise((resolve) => { answer = resolve; }));
  await (await proposed(api)).finish();
  expect(await screen.findByText('Loading TownwiseAI’s suggestions…')).toBeTruthy();
  expect(screen.queryByText('Loading the order…')).toBeNull();
  await act(async () => {
    answer(open());
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  });
  expect(await screen.findByText(HEADLINE)).toBeTruthy();
});

test('says so when the conversation also read web pages', async () => {
  const api = served(() => open({ readWeb: true }));
  await (await proposed(api)).finish();
  expect(await screen.findByText('This reply also read web pages, which Townwise didn’t check. Look over each change before you save.')).toBeTruthy();
});

test('a card whose file was turned off or deleted says it isn’t available', async () => {
  const api = served(() => new ApiError('http', 'The request was refused.', { status: 404, code: 'not_found' }));
  await (await proposed(api)).finish();
  // UI review 1: the common path on reopening a conversation, said with its reason and not as an error.
  const gone = await screen.findByText('These suggestions aren’t available any more. The file they came from may have been turned off or deleted.');
  expect(gone.closest('[role="alert"]')).toBeNull();
  expect(screen.queryByText('This proposal isn’t available.')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  cleanup();

  // Any other failure of the card's own read says to reload.
  const down = served(() => new ApiError('network', 'The request failed.'));
  await (await proposed(down)).finish();
  expect(await screen.findByText('Townwise couldn’t load these suggestions. Reload the page to try again.')).toBeTruthy();
  cleanup();

  // The setup itself failing to load says that, and offers nothing to open.
  const broken = served();
  broken.reads[SETUP] = () => new ApiError('network', 'The request failed.');
  await (await proposed(broken)).finish();
  expect(await screen.findByText('Townwise couldn’t load your ordering setup, so it can’t show what these suggestions would change. Reload the page to try again.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
});

// Security review L1: under view-as the server sends counts only, and the card shows nothing from the file.
test('under view-as the card shows how many suppliers and items were suggested, no name, no change and no action', async () => {
  const api = served();
  api.conversation = {
    ...CONVERSATION,
    messages: [CONVERSATION.messages[0], {
      nodeId: 'a1', role: 'assistant', text: '', proposals: [], at: '2026-11-02T14:59:01.000Z', parts: [{ type: 'tool', ...TOOL }],
    }],
  };
  let setupReads = 0;
  api.reads[SETUP] = () => { setupReads += 1; return SETUP_ANSWER; };
  api.reads['/api/org/locations/l1/chat/c1/order-proposals/' + CALL] = () => ({ proposal: { kind: 'setup', status: 'open', counts: { suppliers: 1, items: 2 }, readWeb: true } });
  renderAt('/locations/l1/agent', api, viewAsMe(ACCESS.member));
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
  expect(await screen.findByText('TownwiseAI suggested 1 supplier and 2 items from an attached file. Their names aren’t shown while viewing as someone else.')).toBeTruthy();
  expect(screen.getByText('Ordering setup suggestions')).toBeTruthy();
  expect(screen.queryByText(HEADLINE)).toBeNull();
  expect(screen.queryByText(/Sample Lager|Sample Stout|New Brewery|would change/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
  // Nothing is compared, so the setup is not read for the card.
  expect(setupReads).toBe(0);
  expect(api.writes).toEqual([]);
});

// UI review 5 and notes: a long change list is cut on the card, and a card with nothing to open offers nothing.
test('the card lists the first ten changed items and says how many more Ordering setup lists', async () => {
  const names = Array.from({ length: 12 }, (_, index) => `Sample Item ${String(index + 1).padStart(2, '0')}`);
  const setup = { ...SAVED, items: names.map((name, index) => ({ ...SAVED.items[0], id: `b${String(index).padStart(23, '0')}`, name })) };
  const api = served(() => open({ read: { ...READ, suppliers: [], items: names.map((name) => item(name, { unit: 'kegs' })) } }));
  api.reads[SETUP] = () => ({ ...SETUP_ANSWER, setup });
  await (await proposed(api)).finish();
  expect(await screen.findByText('12 items already in your setup by name would change:')).toBeTruthy();
  expect(screen.getByText('Sample Item 10: unit: “cases” becomes “kegs”')).toBeTruthy();
  expect(screen.queryByText('Sample Item 11: unit: “cases” becomes “kegs”')).toBeNull();
  expect(screen.getByText('and 2 more. Ordering setup lists every one.')).toBeTruthy();
});

test('a card with nothing to open offers no Review: nothing suggested, or only items left out', async () => {
  const nothing = served(() => open({ read: { ...READ, suppliers: [], items: [] } }));
  await (await proposed(nothing)).finish();
  expect(await screen.findByText('TownwiseAI found nothing to suggest.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review in Ordering setup' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
  expect(screen.queryByText(/Nothing is saved yet/)).toBeNull();
});

// UI review 6: the caveat for a picture, in the words Ordering setup uses too.
test('says when the names couldn’t be checked against the file’s text', async () => {
  const api = served(() => open({ read: { ...READ, items: READ.items.map((each) => ({ ...each, inFile: null })) } }));
  await (await proposed(api)).finish();
  expect(await screen.findByText('Townwise couldn’t check these names against the file’s text, because it was read as a picture.')).toBeTruthy();
});

