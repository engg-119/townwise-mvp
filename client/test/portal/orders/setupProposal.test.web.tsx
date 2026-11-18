import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import type { OrderSetup, OrderSetupAnswer } from '../../../src/portal/orders/api';
import { PROPOSAL_COPY } from '../../../src/portal/orders/SetupProposal';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, type AnalyticsFake } from '../analytics/fakes';

// Ordering setup opened from a TownwiseAI card (spec D56, P31): `?proposal=` names the card by its two ids, and the
// page merges its suggestions into the unsaved draft once. Nothing saves until Save, which the owner presses after
// setting each new item's par. Every supplier and item here is synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

jest.setTimeout(20_000);

afterEach(() => { cleanup(); });

const CONVERSATION = 'c'.repeat(24);
const CALL = 'toolu_order_setup_0001';
const ROUTE = `/locations/l1/orders/setup?proposal=${CONVERSATION}.${CALL}`;
const PATH = '/api/org/locations/l1/orders';
const CARD = `/api/org/locations/l1/chat/${CONVERSATION}/order-proposals/${CALL}`;
const SUPPLIER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const LAGER_ID = 'bbbbbbbbbbbbbbbbbbbbbbb1';

const SETUP: OrderSetup = {
  version: 3,
  updatedAt: '2026-11-10T15:00:00.000Z',
  suppliers: [{ id: SUPPLIER_ID, name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
  items: [{
    id: LAGER_ID, name: 'Sample Lager', supplierId: SUPPLIER_ID, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 2,
    dealSize: 5, neverRunOut: false, posNames: [{ name: 'Lager Can', perSale: 1 }],
  }],
};

const ANSWER: OrderSetupAnswer = {
  today: '2026-11-13', setup: SETUP, coverage: null, itemCoverage: {}, counts: {}, itemsWithHistory: [], canReadWithAi: false,
};

function item(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null, posNames: [], note: '',
    inFile: true, ...fields,
  };
}

function card(items: Record<string, unknown>[], over: Record<string, unknown> = {}): unknown {
  return {
    proposal: {
      kind: 'setup', status: 'open', readWeb: false,
      read: { kind: 'order_guide', confidence: 'high', suppliers: [], items, itemsCut: false, partial: false },
      ...over,
    },
  };
}

/** A change to the saved lager only, so the merged draft passes every check. */
const LAGER_CHANGE = [item('Sample Lager', { servingsPerUnit: 30 })];
const WITH_NEW = [item('Sample Lager', { servingsPerUnit: 30 }), item('Sample Stout', { supplier: 'Sample Distributor', category: 'draft', unit: 'kegs', servingsPerUnit: 124 })];

function portal(proposal: unknown, me = meOf(ACCESS.member)): { api: FakePortalApi; fake: AnalyticsFake; gets: Record<string, unknown> } {
  const gets: Record<string, unknown> = { [`${PATH}/setup`]: ANSWER, [CARD]: proposal };
  const fake = analyticsFake(gets);
  return { api: fakePortalApi({ me, org: orgOf('member'), fallback: fake }), fake, gets };
}

function renderAt(api: FakePortalApi, route = ROUTE): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', route);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={route} />
    </Head.Provider>,
  );
}

async function click(name: string, within_: HTMLElement = document.body): Promise<void> {
  await act(async () => {
    fireEvent.click(within(within_).getByRole('button', { name }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function field(regionName: string, label: string): HTMLInputElement {
  return within(screen.getByRole('region', { name: regionName })).getByRole('textbox', { name: label });
}

function puts(api: FakePortalApi): { expectedVersion: number; setup: { items: Record<string, unknown>[] } }[] {
  return writes(api).filter((call) => call.method === 'PUT').map((call) => call.body as { expectedVersion: number; setup: { items: Record<string, unknown>[] } });
}

const stored = (version: number, servingsPerUnit: number): { setup: OrderSetup } => ({
  setup: { ...SETUP, version, items: [{ ...SETUP.items[0], servingsPerUnit } as OrderSetup['items'][number]] },
});

const FOUND_TWO = 'TownwiseAI found 2 items: 1 new, 1 replaced by name. Nothing is saved yet: check them below, then save the setup.';
const FOUND_ONE = 'TownwiseAI found 1 item: 0 new, 1 replaced by name. Nothing is saved yet: check them below, then save the setup.';

test('with ?proposal= it merges the card into the unsaved draft and says what it did; nothing is saved', async () => {
  const { api } = portal(card(WITH_NEW, { read: { kind: 'order_guide', confidence: 'high', suppliers: [], items: WITH_NEW, itemsCut: true, partial: false } }));
  renderAt(api);
  expect(await screen.findByText(FOUND_TWO)).toBeTruthy();
  expect(screen.getByText(PROPOSAL_COPY.heading)).toBeTruthy();
  expect(screen.getByText('Set the par of the new item.')).toBeTruthy();
  // The chat's own cut line, never the read's 150.
  expect(screen.getByText('The file lists more items than TownwiseAI suggests in a chat (60), so some were left out. For the rest, use Read a file with TownwiseAI on Ordering setup, on the web.')).toBeTruthy();
  expect(screen.queryByText(/\(150\)/)).toBeNull();
  // The matched item took the suggestion and kept its par; the new one has a blank par.
  expect(field('Item 1', 'Servings per unit').value).toBe('30');
  expect(field('Item 1', 'Par').value).toBe('2');
  expect(field('Item 2', 'Item name').value).toBe('Sample Stout');
  expect(field('Item 2', 'Par').value).toBe('');
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('Save names each new item’s blank par', async () => {
  const { api } = portal(card(WITH_NEW));
  renderAt(api);
  await screen.findByText(FOUND_TWO);
  await click('Save the setup');
  expect(within(screen.getByRole('region', { name: 'Item 2' })).getByText('Enter a whole number from 0 to 999.')).toBeTruthy();
  expect(screen.getByText('Fix the 1 marked field before saving.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('after Load their changes the suggestions are merged into the reloaded draft again', async () => {
  const { api, gets } = portal(card(LAGER_CHANGE));
  api.answers[`${PATH}/setup`] = () => refusal(409, 'setup_changed');
  renderAt(api);
  await screen.findByText(FOUND_ONE);
  await click('Save the setup');
  expect(await screen.findByText(/^Someone else changed this setup since you opened it\./)).toBeTruthy();
  gets[`${PATH}/setup`] = { ...ANSWER, setup: { ...SETUP, version: 5, items: [{ ...SETUP.items[0], par: 9 }] } };
  await click('Load their changes');
  await click('Load their changes', await screen.findByRole('dialog', { name: 'Load their changes' }));
  // Their par, and the suggestion on top of it again.
  await waitFor(() => { expect(field('Item 1', 'Par').value).toBe('9'); });
  await waitFor(() => { expect(field('Item 1', 'Servings per unit').value).toBe('30'); });
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  expect(screen.getByText(FOUND_ONE)).toBeTruthy();
  api.answers[`${PATH}/setup`] = () => stored(6, 30);
  await click('Save the setup');
  await waitFor(() => { expect(puts(api)).toHaveLength(2); });
  expect(puts(api)[1]).toMatchObject({ expectedVersion: 5, setup: { items: [{ id: LAGER_ID, par: 9, servingsPerUnit: 30 }] } });
});

test('after a save it stops and drops the query', async () => {
  const { api, fake } = portal(card(LAGER_CHANGE));
  api.answers[`${PATH}/setup`] = () => stored(4, 30);
  renderAt(api);
  await screen.findByText(FOUND_ONE);
  await click('Save the setup');
  expect(await screen.findByText('Saved the ordering setup.')).toBeTruthy();
  await waitFor(() => { expect(screen.queryByText(FOUND_ONE)).toBeNull(); });
  expect(screen.queryByText(PROPOSAL_COPY.heading)).toBeNull();
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  expect(puts(api)).toHaveLength(1);
  // The card was read once and is not read or merged again: an edit after the save stays the person's own.
  fireEvent.change(field('Item 1', 'Servings per unit'), { target: { value: '24' } });
  await act(() => new Promise((resolve) => { setTimeout(resolve, 20); }));
  expect(field('Item 1', 'Servings per unit').value).toBe('24');
  expect(fake.paths.filter((path) => path === CARD)).toHaveLength(1);
});

test('a set-aside or unavailable card says so and leaves the draft alone', async () => {
  const aside = portal(card(WITH_NEW, { status: 'dismissed' }));
  renderAt(aside.api);
  expect(await screen.findByText(PROPOSAL_COPY.dismissed)).toBeTruthy();
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Item 2' })).toBeNull();
  cleanup();

  const gone = portal(new ApiError('http', 'not_found', { status: 404, code: 'not_found' }));
  renderAt(gone.api);
  expect(await screen.findByText(PROPOSAL_COPY.unavailable)).toBeTruthy();
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  cleanup();

  // A value that is not two ids asks for nothing and says nothing.
  const malformed = portal(card(WITH_NEW));
  renderAt(malformed.api, '/locations/l1/orders/setup?proposal=..%2F..%2Fme');
  await screen.findByRole('region', { name: 'Item 1' });
  expect(screen.queryByText(PROPOSAL_COPY.heading)).toBeNull();
  expect(malformed.fake.paths.filter((path) => path.includes('/chat/'))).toEqual([]);
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
});

test('under view-as nothing is merged', async () => {
  const { api, fake } = portal(card(WITH_NEW), viewAsMe(ACCESS.member));
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  expect(screen.getByText(PROPOSAL_COPY.readOnly)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Item 2' })).toBeNull();
  expect(field('Item 1', 'Servings per unit').value).toBe('24');
  expect(fake.paths.filter((path) => path === CARD)).toEqual([]);
  expect(writes(api)).toEqual([]);
});
