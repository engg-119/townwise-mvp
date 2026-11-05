jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import type { MeResponse } from '../../../src/portal/schemas';
import { fakeChatApi, refusal as chatRefusal, type FakeChatApi } from '../../helpers/chat';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';

// The tuning chat inside the portal on native: view-as keeps every write control in place and disabled (spec
// 15.5), and on phones the location's header and tabs scroll with the thread so the conversation gets the screen.

afterEach(async () => {
  await cleanup();
});

const WINDOW = Dimensions.get('window');

async function renderChat(me: MeResponse, chat: FakeChatApi = fakeChatApi()): Promise<FakeChatApi> {
  await renderApp('/locations/l1/chat', fakePortalApi({ me, org: orgOf('member'), fallback: chat }));
  await screen.findAllByRole('heading', { name: 'Main Street Bar' });
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

describe('the chat’s height on phones', () => {
  test('at 375px the location header, switcher and tabs sit at the top of the thread, and the composer stays below it', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
    try {
      await renderChat(meOf(ACCESS.member));
      const thread = await screen.findByTestId('chat-thread');
      expect(within(thread).getByLabelText('Location sections')).toBeTruthy();
      expect(within(thread).getByRole('button', { name: 'Location' })).toBeTruthy();
      // The page's h1 and the chat's own title both scroll away with the thread.
      expect(within(thread).getAllByRole('heading', { name: 'Main Street Bar' })).toHaveLength(2);
      expect(within(thread).getByRole('button', { name: 'Back to locations' })).toBeTruthy();
      expect(within(thread).queryByLabelText('Message')).toBeNull();
      expect(screen.getByLabelText('Message')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  test('at 375px the header still shows when the chat can’t load', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
    try {
      const chat = fakeChatApi();
      chat.chatError = chatRefusal(503, 'unavailable');
      await renderChat(meOf(ACCESS.member), chat);
      expect(screen.getByLabelText('Location sections')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  test('wider screens keep the header and tabs above the chat, as before', async () => {
    await renderChat(meOf(ACCESS.member));
    const thread = await screen.findByTestId('chat-thread');
    expect(within(thread).queryByLabelText('Location sections')).toBeNull();
    expect(within(thread).queryByRole('button', { name: 'Back to locations' })).toBeNull();
    expect(screen.getByLabelText('Location sections')).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Main Street Bar' })).toHaveLength(2);
  });
});
