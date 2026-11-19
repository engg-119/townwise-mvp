import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe } from '../../helpers/portal';
import { fileViewOf } from '../files/fakes';
import { locationsFake } from '../locations/fakes';
import { aiOf, dataFake, itemOf, type DataFake } from './fakes';

// The TownwiseAI opt-in under Your data's Add a file (P26, D34): off by default, so an added file is never sent; checked,
// each file that finishes uploading is sent once to be read, except a kind TownwiseAI can't read; a refusal shows
// beside its file and never undoes the upload, and 503 ai_unavailable hides the box. Files are synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

// D61: Your data's rows read as one table, Newest first, remembered for the person signed in.
beforeEach(() => { window.localStorage.setItem('townwise.dataView.u1', 'newest'); });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const OPT_IN = 'Let TownwiseAI read these files and use what it finds';

function setup(me: MeResponse = meOf(ACCESS.admin)): DataFake {
  const fake = dataFake({ inner: locationsFake() });
  const api = fakePortalApi({ me, org: orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', '/locations/l1/data');
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location="/locations/l1/data" />
    </Head.Provider>,
  );
  return fake;
}

/** Drops files on Add a file and lets every chunk through, so each finishes. */
async function add(fake: DataFake, names: string[]): Promise<void> {
  await screen.findByRole('button', { name: 'Add a file' });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  fireEvent.change(input, { target: { files: names.map((name) => new File(['menu'], name)) } });
  for (let index = 0; index < names.length; index += 1) {
    await waitFor(() => { expect(fake.files.puts.length).toBeGreaterThan(index); });
    await act(async () => { fake.files.puts[index]?.ok(); await Promise.resolve(); });
  }
  await waitFor(() => { expect(fake.files.calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(names.length); });
}

async function optIn(): Promise<void> {
  const box = await screen.findByRole('checkbox', { name: OPT_IN });
  expect((box as HTMLInputElement).checked).toBe(false);
  fireEvent.click(box);
  expect((box as HTMLInputElement).checked).toBe(true);
}

test('the box is off by default and says what reading sends, with the privacy link; an added file is never sent', async () => {
  const fake = setup();
  const box = await screen.findByRole('checkbox', { name: OPT_IN });
  expect((box as HTMLInputElement).checked).toBe(false);
  const help = screen.getByText('Each file you add is sent whole to Anthropic’s Claude to read. You can undo what TownwiseAI adds from a file on its page.');
  expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(help.id);
  expect(screen.getByRole('link', { name: 'How Townwise handles your data' }).getAttribute('href')).toBe('/privacy');

  await add(fake, ['menu.pdf']);
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(fake.ai).toEqual([]);
});

test('checked, each finished file is sent once to be read, and the line beside it says so', async () => {
  const fake = setup();
  fake.answers['POST ai'] = () => ({ item: itemOf('f_f1', { ai: aiOf({ status: 'queued', kind: null }) }) });
  await optIn();
  await add(fake, ['menu.pdf', 'june.csv']);
  await waitFor(() => { expect(fake.ai).toHaveLength(2); });
  expect(fake.ai).toEqual([{ method: 'POST', ref: 'f_f1', body: {} }, { method: 'POST', ref: 'f_f2', body: {} }]);
  const files = screen.getByRole('list', { name: 'Files being added' });
  await waitFor(() => {
    expect(within(files).getAllByText('Added. TownwiseAI is reading it; open it on Your data to see what it finds.')).toHaveLength(2);
  });
});

test('once TownwiseAI takes a file, the list loads again, so the file’s row says it is reading it', async () => {
  const fake = setup();
  const answer = deferred<unknown>();
  fake.answers['POST ai'] = () => answer.promise;
  await optIn();
  await add(fake, ['menu.pdf']);
  await waitFor(() => { expect(fake.ai).toHaveLength(1); });
  // The upload's own reload ran before TownwiseAI answered.
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  const before = fake.lists.length;
  const read = itemOf('f_f1', { name: 'menu.pdf', kind: 'pdf', state: 'kept', outcome: 'reference', ai: aiOf({ status: 'queued', kind: null }) });
  fake.items = [read];
  await act(async () => { answer.resolve({ item: read }); await Promise.resolve(); });
  await waitFor(() => { expect(fake.lists.length).toBeGreaterThan(before); });
  expect(await screen.findByText('Kept for reference · TownwiseAI is reading it')).toBeTruthy();
});

test('the opt-in sits under Add a file, out of Paste text’s row', async () => {
  setup();
  const box = await screen.findByRole('checkbox', { name: OPT_IN });
  const paste = screen.getByRole('button', { name: 'Paste text' });
  expect(paste.parentElement?.contains(box)).toBe(false);
  expect(paste.parentElement?.contains(screen.getByRole('button', { name: 'Add a file' }))).toBe(false);
});

test('a kind TownwiseAI can’t read is not sent, and says why beside the file', async () => {
  const fake = setup();
  fake.files.answers['POST /files/f1/complete'] = () => ({
    file: fileViewOf('f1', { name: 'old.xls', kind: 'xls', status: 'kept', purpose: 'reference', importId: null, result: null }), import: null,
  });
  await optIn();
  await add(fake, ['old.xls']);
  expect(await screen.findByText('Added. TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and add it again to let TownwiseAI read it.')).toBeTruthy();
  expect(fake.ai).toEqual([]);
});

test('503 ai_unavailable says so beside the file, keeps the upload, and hides the box', async () => {
  const fake = setup();
  fake.answers['POST ai'] = () => refusal(503, 'ai_unavailable');
  await optIn();
  await add(fake, ['menu.pdf']);
  expect(await screen.findByText('Added, but TownwiseAI didn’t start reading it. TownwiseAI can’t read files right now. Try again later.')).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: OPT_IN })).toBeNull();
  expect(fake.files.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
});

test('view-as: the box is shown disabled and can’t be checked', async () => {
  setup(viewAsMe(ACCESS.admin));
  const box = await screen.findByRole('checkbox', { name: OPT_IN });
  expect(box.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(box);
  expect((box as HTMLInputElement).checked).toBe(false);
});
