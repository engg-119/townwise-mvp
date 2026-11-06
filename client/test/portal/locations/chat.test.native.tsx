jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions, StyleSheet } from 'react-native';
import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import type { MeResponse } from '../../../src/portal/schemas';
import { fakeChatApi, PROPOSAL, refusal as chatRefusal, type FakeChatApi } from '../../helpers/chat';
import { ACCESS, fakePortalApi, LOCATIONS, meOf, orgOf, refusal, staffMe, viewAsMe } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';

// TownwiseAI (the tuning chat) inside the portal on native: view-as keeps every write control in place and
// disabled (spec 15.5), and on phones a compact location header scrolls with the thread so the conversation gets
// the screen.

afterEach(async () => {
  await cleanup();
});

const WINDOW = Dimensions.get('window');

async function renderChat(me: MeResponse, chat: FakeChatApi = fakeChatApi()): Promise<FakeChatApi> {
  await renderApp('/locations/l1/agent', fakePortalApi({ me, org: orgOf('member'), fallback: chat }));
  await screen.findByText('Main Street Bar, Hanover, NH');
  return chat;
}

describe('view-as', () => {
  test('the composer, Send, New conversation and Add note stay in place, disabled, with one read-only line', async () => {
    const chat = await renderChat(viewAsMe(ACCESS.member));
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    const input = screen.getByLabelText('Message');
    expect(input.props.editable).toBe(false);
    await fireEvent.changeText(input, 'Hello');
    expect(screen.getByLabelText('Message').props.value).toBe('');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(send);
    expect(chat.turns).toHaveLength(0);
    // Reading is allowed: the target's past conversation opens.
    await fireEvent.press(screen.getByRole('button', { name: /^Earlier chat/ }));
    expect(await screen.findByText('We close for the holidays.')).toBeTruthy();
    for (const name of ['Add note', 'New conversation']) {
      const control = screen.getByRole('button', { name });
      expect(control.props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(control);
    }
    expect(chat.requests).toHaveLength(0);
    expect(screen.getByText('We close for the holidays.')).toBeTruthy();
    expect(screen.getAllByText('Read-only while viewing as gm@example.org.')).toHaveLength(1);
  });

  test('outside view-as there is no read-only line and the composer takes text', async () => {
    await renderChat(meOf(ACCESS.member));
    await fireEvent.changeText(await screen.findByLabelText('Message'), 'Hello');
    expect(screen.getByRole('button', { name: 'Send' }).props.accessibilityState).not.toMatchObject({ disabled: true });
    expect(screen.queryByText(/^Read-only while viewing as/)).toBeNull();
  });
});

describe('the portal’s client (spec 4.3)', () => {
  // auth.api is the bare fake; the portal's api wraps it and re-reads GET /api/me on the access errors. Only the
  // portal's api routes again, so a chat that called auth.api directly would stay put and show an error.
  async function refusedChat(me: MeResponse, after: MeResponse) {
    const chat = fakeChatApi();
    chat.chatError = refusal(403, 'no_access');
    const api = fakePortalApi({ me, org: orgOf('member'), fallback: chat });
    const json = api.json.bind(api);
    api.json = (path, schema, opts) => {
      const answer = json(path, schema, opts);
      if (path === '/api/me') api.me = after;
      return answer;
    };
    const { router, auth } = await renderApp('/locations/l1/agent', api);
    expect(auth.api).toBe(api);
    return { api, router };
  }

  test('a member removed meanwhile is routed to No access, not shown an error', async () => {
    const { api, router } = await refusedChat(meOf(ACCESS.member), meOf(ACCESS.removed));
    await waitFor(() => { expect(router.getPathname()).toBe('/no-access'); });
    expect(api.calls.filter((call) => call.path === '/api/me')).toHaveLength(2);
    expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
  });

  test('a view-as grant that expired meanwhile lands staff on the console', async () => {
    const { router } = await refusedChat(viewAsMe(ACCESS.member), staffMe());
    await waitFor(() => { expect(router.getPathname()).toBe('/admin'); });
    expect(screen.queryByRole('region', { name: 'View-as' })).toBeNull();
  });

  test('a note added from a card reads the organization again on leaving, so Locations shows the new count', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fakeChatApi() });
    await renderApp('/locations/l1/agent', api);
    await fireEvent.press(await screen.findByRole('button', { name: /^Earlier chat/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Note added.')).toBeTruthy();
    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/org/locations/l1/notes', body: PROPOSAL },
    ]);
    const reads = api.calls.filter((call) => call.path === '/api/org').length;
    api.org = orgOf('member', LOCATIONS.map((location) => (location.id === 'l1' ? { ...location, notesCount: 3 } : location)));
    await fireEvent.press(screen.getByRole('button', { name: 'Back to locations' }));
    expect(await screen.findByText('3 notes')).toBeTruthy();
    expect(api.calls.filter((call) => call.path === '/api/org').length).toBeGreaterThan(reads);
  });
});

describe('the chat’s height on phones', () => {
  test('at 375px a compact header (the eyebrow, and the title on one line, no switcher) sits at the top of the thread, the sections stay in the top bar, and the composer stays below', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
    try {
      await renderChat(meOf(ACCESS.member));
      const thread = await screen.findByTestId('chat-thread');
      // The page's one h1, TownwiseAI, on one line, scrolls away with the thread, under the eyebrow naming the location.
      const title = within(thread).getByRole('heading', { name: 'TownwiseAI' });
      expect(screen.getAllByRole('heading', { name: 'TownwiseAI' })).toEqual([title]);
      expect(title.props.numberOfLines).toBe(1);
      expect(within(thread).getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
      expect(within(thread).queryByLabelText('Sections')).toBeNull();
      expect(screen.getByLabelText('Sections')).toBeTruthy();
      // The organization has two locations, but the chat on a phone shows neither the switcher nor its links.
      expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'All locations' })).toBeNull();
      expect(within(thread).getByRole('button', { name: 'Back to locations' })).toBeTruthy();
      expect(within(thread).queryByLabelText('Message')).toBeNull();
      expect(screen.getByLabelText('Message')).toBeTruthy();
      // The composer is one row: the input keeps its name, no label is drawn, and Send sits beside it.
      expect(screen.queryByText('Message')).toBeNull();
      expect(StyleSheet.flatten(screen.getByLabelText('Message').parent?.props.style)).toMatchObject({ flexDirection: 'row' });
    } finally {
      spy.mockRestore();
    }
  });

  test('the bubbles and the proposal card have square corners (spec 15.6)', async () => {
    await renderChat(meOf(ACCESS.member));
    await fireEvent.press(screen.getByRole('button', { name: /^Earlier chat/ }));
    const card = (await screen.findByText('Proposed note')).parent;
    const bubble = screen.getByText('You').parent;
    // Replies are labelled with the agent's name.
    expect(within(screen.getByTestId('chat-thread')).getAllByText('TownwiseAI').length).toBeGreaterThan(0);
    for (const box of [card, bubble]) {
      expect(StyleSheet.flatten(box?.props.style)).toMatchObject({ borderWidth: 1, borderRadius: 0 });
    }
  });

  test('at 375px the header still shows when the chat can’t load', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
    try {
      const chat = fakeChatApi();
      chat.chatError = chatRefusal(503, 'unavailable');
      await renderChat(meOf(ACCESS.member), chat);
      expect(screen.getByRole('heading', { name: 'TownwiseAI' })).toBeTruthy();
      expect(screen.getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  test('wider screens keep the full header, with the switcher and All locations, above the chat, and name the location once', async () => {
    await renderChat(meOf(ACCESS.member));
    const thread = await screen.findByTestId('chat-thread');
    expect(within(thread).queryByRole('heading', { name: 'TownwiseAI' })).toBeNull();
    expect(within(thread).queryByRole('button', { name: 'Back to locations' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Location' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All locations' })).toBeTruthy();
    expect(screen.getAllByText('Main Street Bar, Hanover, NH')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'TownwiseAI' })).toHaveLength(1);
    // The composer keeps its drawn label above the input.
    expect(screen.getByText('Message')).toBeTruthy();
  });
});
