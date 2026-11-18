import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import type { DataItem } from '../../src/portal/data/api';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { CONVERSATION, fakeChatApi, type FakeChatApi, forgetLastChats } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { itemOf } from '../portal/data/fakes';
import { serveAbout } from './about-fakes';

// The files a person's message carries (spec P25, D36), as chips over their bubble: the name and kind (the kind alone
// without a name), whether each is turned off or gone, a link to its item page unless it is gone, and on web a
// picture's thumbnail, read as the item page reads a picture and only when the item may be downloaded; under view-as
// the kind alone and no thumbnail. Fixtures are synthetic.

// The page measures its dock and its composer; jsdom has no ResizeObserver.
class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;

const EMAIL = ['a', 'example.com'].join('@');
const PICTURE = 'f_0123456789abcdef01234567';
const MENU = 'f_1111111111111111aaaaaaaa';
const HOURS = 'f_2222222222222222bbbbbbbb';
const OLD = 'f_3333333333333333cccccccc';
const LATER = 'f_4444444444444444dddddddd';
const ITEM_PATH = (ref: string): `/${string}` => `/api/org/locations/l1/data/${ref}`;
const RAW_PATH = (ref: string): `/${string}` => `/api/org/locations/l1/files/${ref.replace(/^f_/, 'file-')}/raw`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

afterEach(() => {
  cleanup();
  // The conversation the page closed on (src/chat/lastChat.ts) is kept in localStorage: each test opens a new page.
  localStorage.clear();
  resetDrafts();
  forgetLastChats();
});

function renderAt(path: string, api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  serveAbout(api);
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

/** CONVERSATION with the person's message carrying `attachments`. */
function carrying(api: FakeChatApi, attachments: unknown[]): void {
  api.conversation = { ...CONVERSATION, messages: [{ ...CONVERSATION.messages[0], attachments }, CONVERSATION.messages[1]] };
}

/** The picture's item, and its bytes behind GET .../raw. */
function servePicture(api: FakeChatApi, item: Partial<DataItem> = {}): { downloads: () => number } {
  let downloads = 0;
  api.reads[ITEM_PATH(PICTURE)] = () => ({ item: itemOf(PICTURE, { kind: 'other', name: 'patio.png', sizeBytes: PNG.length, state: 'kept', ...item }) });
  api.respond[RAW_PATH(PICTURE)] = () => {
    downloads += 1;
    return { ok: true, status: 200, blob: () => Promise.resolve(new Blob([PNG])) };
  };
  return { downloads: () => downloads };
}

async function openEarlierChat(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
  await screen.findByText('We close for the holidays.');
  return screen.getByRole('list', { name: 'Files attached' });
}

test('each file shows its name and kind, or its kind alone, and says when it is turned off or gone', async () => {
  const api = fakeChatApi();
  carrying(api, [
    { ref: MENU, kind: 'pdf', name: 'menu.pdf', state: 'on' },
    { ref: HOURS, kind: 'text', name: 'hours.txt', state: 'off' },
    { ref: OLD, kind: 'excel', name: null, state: 'gone' },
    // A kind this client doesn't know yet reads as a file; an entry with no ref is left out.
    { ref: LATER, kind: 'hologram', name: 'later.holo', state: 'on' },
    { kind: 'pdf', name: 'no-ref.pdf', state: 'on' },
  ]);
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  expect(within(files).getAllByRole('listitem')).toHaveLength(4);
  expect(within(files).getByRole('link', { name: 'menu.pdf, PDF. Open on Your data' })).toBeTruthy();
  expect(within(files).getByRole('link', { name: 'hours.txt, Text file. Turned off on Your data. Open on Your data' })).toBeTruthy();
  expect(within(files).getByText('Text file. Turned off on Your data')).toBeTruthy();
  // Gone: the kind alone, in words, and no page to open.
  expect(within(files).getByText('Excel file')).toBeTruthy();
  expect(within(files).getByText('No longer on Your data')).toBeTruthy();
  expect(within(files).queryByRole('link', { name: /Excel file/ })).toBeNull();
  expect(within(files).getByRole('link', { name: 'later.holo, File. Open on Your data' })).toBeTruthy();
  expect(screen.queryByText('no-ref.pdf')).toBeNull();
  // Over the bubble, inside the person's message.
  const bubble = screen.getByTestId('user-bubble');
  expect(files.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('pressing a chip opens the file’s item page on Your data', async () => {
  const api = fakeChatApi();
  carrying(api, [{ ref: MENU, kind: 'pdf', name: 'menu.pdf', state: 'on' }]);
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  fireEvent.click(within(files).getByRole('link', { name: 'menu.pdf, PDF. Open on Your data' }));
  await waitFor(() => { expect(window.location.pathname).toBe(`/locations/l1/data/${MENU}`); });
});

test('a picture shows a thumbnail at most 240px, from a data: URL of its bytes, fetched as the item page fetches it', async () => {
  const api = fakeChatApi();
  carrying(api, [{ ref: PICTURE, kind: 'picture', name: 'patio.png', state: 'on' }]);
  const served = servePicture(api);
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  const thumb = await within(files).findByTestId('attachment-thumb');
  expect(thumb.getAttribute('src')).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
  expect(thumb.getAttribute('alt')).toBe('');
  expect(getComputedStyle(thumb).maxWidth).toBe('240px');
  expect(getComputedStyle(thumb).maxHeight).toBe('240px');
  // Inside the chip's link, which names the file.
  expect(within(files).getByRole('link', { name: 'patio.png, Picture. Open on Your data' }).contains(thumb)).toBe(true);
  expect(served.downloads()).toBe(1);
});

test('a picture the person may not download, or one turned off, shows the chip alone and fetches no bytes', async () => {
  const api = fakeChatApi();
  carrying(api, [{ ref: PICTURE, kind: 'picture', name: 'patio.png', state: 'on' }]);
  const { file } = itemOf(PICTURE);
  if (file === null) throw new Error('no file');
  const served = servePicture(api, { file: { ...file, canDownloadRaw: false } });
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(within(files).queryByTestId('attachment-thumb')).toBeNull();
  expect(served.downloads()).toBe(0);
  cleanup();

  const off = fakeChatApi();
  carrying(off, [{ ref: PICTURE, kind: 'picture', name: 'patio.png', state: 'off' }]);
  const offServed = servePicture(off);
  renderAt('/locations/l1/agent', off);
  await openEarlierChat();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(screen.queryByTestId('attachment-thumb')).toBeNull();
  expect(offServed.downloads()).toBe(0);
});

test('a picture over 3.75 MB, which TownwiseAI never reads, gets no thumbnail and no download', async () => {
  const api = fakeChatApi();
  carrying(api, [{ ref: PICTURE, kind: 'picture', name: 'patio.png', state: 'on' }]);
  const served = servePicture(api, { sizeBytes: 3_750_001 });
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(within(files).queryByTestId('attachment-thumb')).toBeNull();
  expect(served.downloads()).toBe(0);
});

test('a thumbnail is read once for the page’s life: showing the message again reads nothing', async () => {
  const api = fakeChatApi();
  carrying(api, [{ ref: PICTURE, kind: 'picture', name: 'patio.png', state: 'on' }]);
  const served = servePicture(api);
  let itemReads = 0;
  const read = api.reads[ITEM_PATH(PICTURE)];
  api.reads[ITEM_PATH(PICTURE)] = () => {
    itemReads += 1;
    return read?.();
  };
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  await within(files).findByTestId('attachment-thumb');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await waitFor(() => { expect(screen.queryByText('We close for the holidays.')).toBeNull(); });
  const again = await openEarlierChat();
  expect(within(again).getByTestId('attachment-thumb')).toBeTruthy();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(itemReads).toBe(1);
  expect(served.downloads()).toBe(1);
});

test('a ref that isn’t a well-formed file ref is no link, and nothing is read for it', async () => {
  const api = fakeChatApi();
  const odd = '../../files/f_0123456789abcdef01234567';
  carrying(api, [{ ref: odd, kind: 'picture', name: 'patio.png', state: 'on' }]);
  let reads = 0;
  api.reads[ITEM_PATH(odd)] = () => {
    reads += 1;
    return undefined;
  };
  renderAt('/locations/l1/agent', api);
  const files = await openEarlierChat();
  expect(within(files).queryByRole('link')).toBeNull();
  expect(within(files).getByRole('listitem', { name: 'patio.png, Picture' })).toBeTruthy();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(within(files).queryByTestId('attachment-thumb')).toBeNull();
  expect(reads).toBe(0);
});

test('under view-as a chip shows the kind alone, with no thumbnail and nothing read', async () => {
  const api = fakeChatApi();
  // The server sends no name under view-as.
  carrying(api, [{ ref: PICTURE, kind: 'picture', name: null, state: 'on' }]);
  const served = servePicture(api);
  let itemReads = 0;
  const read = api.reads[ITEM_PATH(PICTURE)];
  api.reads[ITEM_PATH(PICTURE)] = () => {
    itemReads += 1;
    return read?.();
  };
  renderAt('/locations/l1/agent', api, viewAsMe(ACCESS.member));
  const files = await openEarlierChat();
  expect(within(files).getByRole('link', { name: 'Picture. Open on Your data' })).toBeTruthy();
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
  expect(within(files).queryByTestId('attachment-thumb')).toBeNull();
  expect(itemReads).toBe(0);
  expect(served.downloads()).toBe(0);
});
