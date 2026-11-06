jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { Dimensions, StyleSheet } from 'react-native';
import { act, cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import type { MeResponse } from '../../src/portal/schemas';
import { fakeChatApi, PROPOSAL, PROPOSAL_ID, refusal as chatRefusal, SALES_STEP, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { ACCESS, fakePortalApi, LOCATIONS, locationOf, meOf, orgOf, refusal, staffMe, viewAsMe } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';

// P25 TownwiseAI on native (spec 16.3): the chatbox and its side panel inside the portal, against a fake of
// the chat and side panel routes. The Pillars: every tool call is a card and the Based on line comes from the
// cards (transparency); the How TownwiseAI works panel and each question's help line (explainability); "Leave out
// guest names" under the composer, view-as with every write disabled, nothing in device storage (privacy).

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

const WINDOW = Dimensions.get('window');

function at(width: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width });
}

async function renderAgent(me: MeResponse, chat: FakeChatApi = fakeChatApi(), org = orgOf('member')) {
  const portal = fakePortalApi({ me, org, fallback: chat });
  const rendered = await renderApp('/locations/l1/agent', portal);
  await screen.findByText('Main Street Bar, Hanover, NH');
  return { chat, portal, ...rendered };
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('none found');
  return item;
}

function turn(api: FakeChatApi): LiveTurn {
  const live = api.turns.at(-1);
  if (live === undefined) throw new Error('no turn');
  return live;
}

async function send(text: string): Promise<void> {
  await fireEvent.changeText(await screen.findByLabelText(COMPOSER_LABEL), text);
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
}

function disabled(name: string | RegExp): void {
  for (const control of screen.getAllByRole('button', { name })) {
    expect(control.props.accessibilityState).toMatchObject({ disabled: true });
  }
}

describe('an empty conversation', () => {
  test('names the location, says what TownwiseAI reads, offers chips, and keeps the privacy line under the composer', async () => {
    await renderAgent(meOf(ACCESS.member));
    expect(await screen.findByRole('heading', { name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
    expect(screen.getByText('It reads your sales, your notes and Hanover’s town profile, and shows you each thing it reads. It suggests notes; you decide what’s saved.')).toBeTruthy();
    expect(screen.getByText('Leave out guest names. TownwiseAI answers from your sales, your notes and Hanover’s town profile.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Which days last month were unusual?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^What’s coming up in \w+ in Hanover\?$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /forecast/i })).toBeNull();
  });

  test('an Ask chip sends at once; a Tell chip fills the composer and sends nothing', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await fireEvent.press(await screen.findByRole('button', { name: 'We’re closed on …' }));
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('We’re closed on ');
    expect(chat.turns).toHaveLength(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Which days last month were unusual?' }));
    expect(turn(chat).body).toEqual({ content: 'Which days last month were unusual?' });
    // What the person was typing stays in the composer.
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('We’re closed on ');
  });

  test('with no sales yet it says what TownwiseAI can use, and asks what to upload', async () => {
    const org = orgOf('member', [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })]);
    await renderAgent(meOf(ACCESS.member), fakeChatApi(), org);
    expect(await screen.findByText('You haven’t uploaded sales yet, so TownwiseAI can only use your notes and Hanover’s town profile.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What should I upload?' })).toBeTruthy();
  });
});

describe('a reply', () => {
  test('shows thinking, then a running card, then text; folds its cards when done, with a Based on line from them', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await send('How was December?');
    expect(screen.getByText('How was December?')).toBeTruthy();
    expect(screen.getByText('TownwiseAI is thinking…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await act(() => { turn(chat).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: SALES_STEP.input, result: null }); });
    expect(screen.queryByText('TownwiseAI is thinking…')).toBeNull();
    expect(screen.getByText('Reading')).toBeTruthy();
    expect(screen.getByText('your sales for Dec 1 to Dec 31, 2025')).toBeTruthy();
    await act(() => {
      turn(chat).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
      turn(chat).emit('text', { delta: 'December was steady.' });
      turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0.01 });
      turn(chat).end();
    });
    expect(await screen.findByText('December was steady.')).toBeTruthy();
    expect(screen.getByText('Read 1 thing')).toBeTruthy();
    expect(screen.getByText('Based on your sales from Dec 1 to Dec 31, 2025.')).toBeTruthy();
    // Folded: the row shows again on Show, and opens to what it read.
    expect(screen.queryByText('31 days: guests on 31, net sales on 30')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Read your sales for Dec 1 to Dec 31, 2025. 31 days: guests on 31, net sales on 30' }));
    expect(screen.getByText('Days with net sales')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  test('a stopped reply keeps what arrived, says it wasn’t saved, and Try again sends the message again', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await send('Hello');
    await act(() => { turn(chat).emit('text', { delta: 'Half a rep' }); });
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped. Your message and this reply weren’t saved.')).toBeTruthy();
    expect(screen.getByText('Half a rep')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(chat.turns).toHaveLength(2);
    expect(turn(chat).body).toEqual({ content: 'Hello' });
    expect(screen.queryByText('Half a rep')).toBeNull();
  });
});

describe('a proposed note', () => {
  async function proposedCard(chat: FakeChatApi): Promise<void> {
    await send('Closed Christmas week');
    await act(() => {
      turn(chat).emit('conversation', { id: 'c2', title: 'Closed Christmas week' });
      turn(chat).emit('text', { delta: 'Here is a note.' });
      turn(chat).emit('proposal', { id: PROPOSAL_ID, proposal: PROPOSAL });
    });
    // Until the turn is stored, the actions wait.
    disabled('Save note');
    await act(() => {
      turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(chat).end();
    });
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Save note' }).props.accessibilityState).not.toMatchObject({ disabled: true }); });
  }

  test('Save note saves it through the proposal route and says so, with a link to Notes', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await proposedCard(chat);
    for (const text of ['Proposed note', 'Closure', 'December 24, 2026 to December 26, 2026', 'Closed', 'Closed for the holidays.']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Saved to Notes.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Notes' })).toBeTruthy();
    expect(chat.writes).toEqual([{ method: 'POST', path: `/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`, body: { action: 'save' } }]);
  });

  test('Edit first opens the note form filled in; its save sends the edit', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await proposedCard(chat);
    await fireEvent.press(screen.getByRole('button', { name: 'Edit first' }));
    expect(await screen.findByRole('heading', { name: 'Add a note' })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Details (optional)'), 'Closed for the holidays, back on the 27th.');
    await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Saved to Notes, with your changes.')).toBeTruthy();
    expect(chat.writes.at(-1)).toMatchObject({ body: { action: 'save', note: { ...PROPOSAL, detail: 'Closed for the holidays, back on the 27th.' } } });
  });

  test('Not now folds the card to one line, recorded; Show the note opens it again', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await proposedCard(chat);
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Not now.')).toBeTruthy();
    expect(chat.writes).toEqual([{ method: 'POST', path: `/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`, body: { action: 'dismiss' } }]);
    await fireEvent.press(screen.getByRole('button', { name: 'Show the note' }));
    expect(screen.getByRole('button', { name: 'Save note' })).toBeTruthy();
  });

  test('a refusal stays on the card', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await proposedCard(chat);
    chat.respond[`/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`] = () => chatRefusal(409, 'note_limit');
    await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('This location has 1,000 notes. Delete old ones to add more.')).toBeTruthy();
  });
});

describe('conversations', () => {
  test('a past conversation replays its text, its tool cards and its proposal; Delete asks first', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await fireEvent.press(await screen.findByRole('button', { name: 'Conversations' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    expect(await screen.findByText('We close for the holidays.')).toBeTruthy();
    expect(screen.getByText('Last December you were open every day.')).toBeTruthy();
    expect(screen.getByText('Read 1 thing')).toBeTruthy();
    expect(screen.getByText('Based on your sales from Dec 1 to Dec 31, 2025.')).toBeTruthy();
    expect(screen.getByText('Proposed note')).toBeTruthy();
    expect(screen.getAllByText('Earlier chat').length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByRole('button', { name: 'Conversations' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Delete Earlier chat' }));
    expect(await screen.findByText('TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => { expect(screen.queryByText('We close for the holidays.')).toBeNull(); });
    expect(chat.writes).toEqual([{ method: 'DELETE', path: '/api/org/locations/l1/chat/c1', body: undefined }]);
    expect(screen.getByText('New conversation')).toBeTruthy();
  });

  test('the bubbles and the proposal card have square corners (spec 15.6)', async () => {
    await renderAgent(meOf(ACCESS.member));
    await fireEvent.press(await screen.findByRole('button', { name: 'Conversations' }));
    await fireEvent.press(screen.getByRole('button', { name: /^Earlier chat/ }));
    const card = (await screen.findByText('Proposed note')).parent;
    const bubble = screen.getByText('You').parent;
    for (const box of [card, bubble]) {
      expect(StyleSheet.flatten(box?.props.style)).toMatchObject({ borderWidth: 1, borderRadius: 0 });
    }
  });
});

describe('states', () => {
  test('off: says TownwiseAI isn’t turned on yet, with no composer', async () => {
    const chat = fakeChatApi();
    chat.summary = { ...SUMMARY, enabled: false };
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('TownwiseAI isn’t turned on yet.')).toBeTruthy();
    expect(screen.queryByLabelText(COMPOSER_LABEL)).toBeNull();
  });

  test('budget used up: a panel in place of the composer says when it comes back, and that Home and Analytics don’t depend on it', async () => {
    const chat = fakeChatApi();
    chat.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 20, exhausted: true } };
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('Test Group has used its TownwiseAI budget for November. It comes back on Dec 1. Home and Analytics don’t depend on it.')).toBeTruthy();
    expect(screen.queryByLabelText(COMPOSER_LABEL)).toBeNull();
  });

  test('a chat that can’t load says so with Try again', async () => {
    const chat = fakeChatApi();
    chat.chatError = chatRefusal(503, 'unavailable');
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'TownwiseAI' })).toBeTruthy();
  });
});

describe('the side panel at 1280px', () => {
  test('questions with what each answer does; an answer saves and says what it did', async () => {
    at(1280);
    const { chat } = await renderAgent(meOf(ACCESS.member));
    const side = await screen.findByTestId('agent-side');
    expect(within(side).getByRole('heading', { name: 'Questions for you' })).toBeTruthy();
    expect(await within(side).findByText('2 open')).toBeTruthy();
    expect(within(side).getByRole('heading', { name: 'Are you closed on Mondays?' })).toBeTruthy();
    expect(within(side).getByText('Main Street Bar has no sales on 41 of the last 52 Mondays.')).toBeTruthy();
    expect(within(side).getByText('Yes saves a closure note for Mondays from Nov 3, 2025 to Nov 2, 2026. Any answer stops this question.')).toBeTruthy();
    expect(within(side).getByRole('heading', { name: 'Were you closed Feb 1 to Feb 3, 2026?' })).toBeTruthy();
    expect(within(side).getByText('There are no sales for these 3 days.')).toBeTruthy();
    expect(within(side).getByText('TownwiseAI’s own research (unusual nights, town events it finds) is planned.')).toBeTruthy();

    await fireEvent.press(within(side).getByRole('button', { name: 'Yes, closed Mondays' }));
    expect(await within(side).findByText('Saved a note: Closure, Mondays, Nov 3, 2025 to Nov 2, 2026. TownwiseAI treats those days as closed.')).toBeTruthy();
    expect(chat.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/agent/questions/weekday_1_2025-11-03_2026-11-02', body: { answer: 'closed' } }]);
    expect(within(side).getByText('1 open')).toBeTruthy();
    await fireEvent.press(within(side).getByRole('button', { name: 'Not sure' }));
    expect(await within(side).findByText('Got it. TownwiseAI won’t ask about these days again.')).toBeTruthy();
  });

  test('activity lists only real, dated events, and the budget shows as percent used', async () => {
    at(1280);
    await renderAgent(meOf(ACCESS.member));
    const side = await screen.findByTestId('agent-side');
    expect(await within(side).findByText('Saved a note you approved: Closure, Nov 26, 2026.')).toBeTruthy();
    expect(within(side).getByText('Read your upload for Oct 26 to Nov 1, 2026, 7 days.')).toBeTruthy();
    expect(within(side).getByText('You said the data is missing for Jan 1 to Jan 2, 2026.')).toBeTruthy();
    // A kind this client doesn't know (forecast_made) shows as nothing.
    expect(within(side).getAllByText(/^(Saved|Read|You said)/)).toHaveLength(3);
    expect(within(side).getByText('November: 6% used. Resets Dec 1.')).toBeTruthy();
  });

  test('How TownwiseAI works says what it reads, what it can’t see, that no forecast exists, and who receives the data', async () => {
    at(1280);
    await renderAgent(meOf(ACCESS.member));
    const side = await screen.findByTestId('agent-side');
    await fireEvent.press(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
    for (const text of [
      'It reads your sales, your notes and Hanover’s town profile, and shows you each thing it reads.',
      'It can’t see the weather, your staffing, your bookings unless you add them as notes, or guest names.',
      'It suggests notes; it never saves one without you.',
      'Townwise has no forecast for this location yet, so TownwiseAI answers from your history, your notes and the town profile.',
    ]) expect(within(side).getByText(text)).toBeTruthy();
    expect(within(side).getByText(/Your messages and the data it reads go to Anthropic/)).toBeTruthy();
  });

  test('the side panel loads even while TownwiseAI is off, and an empty panel says so', async () => {
    at(1280);
    const chat = fakeChatApi();
    chat.summary = { ...SUMMARY, enabled: false };
    chat.panel = { questions: [], activity: [] };
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('No questions right now.')).toBeTruthy();
    expect(screen.getByText('Nothing yet. Upload sales or save a note and it shows here.')).toBeTruthy();
  });

  test('a panel that can’t load says so with Try again, and reads again', async () => {
    at(1280);
    const chat = fakeChatApi();
    chat.panelError = refusal(503, 'unavailable');
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('Couldn’t load TownwiseAI’s questions.')).toBeTruthy();
    chat.panelError = null;
    await fireEvent.press(first(screen.getAllByRole('button', { name: 'Try again' })));
    expect(await screen.findByText('Are you closed on Mondays?')).toBeTruthy();
  });
});

describe('phones', () => {
  test('at 375px the compact header and the switch sit at the top of the thread; the chat keeps its state while Questions shows', async () => {
    at(375);
    await renderAgent(meOf(ACCESS.member));
    const thread = await screen.findByTestId('chat-thread');
    const title = within(thread).getByRole('heading', { name: 'TownwiseAI' });
    expect(title.props.numberOfLines).toBe(1);
    expect(within(thread).getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
    expect(within(thread).queryByLabelText(COMPOSER_LABEL)).toBeNull();
    // The composer is one row, its label the input's name.
    expect(screen.queryByText(COMPOSER_LABEL)).toBeNull();
    expect(StyleSheet.flatten(screen.getByLabelText(COMPOSER_LABEL).parent?.props.style)).toMatchObject({ flexDirection: 'row' });
    await fireEvent.changeText(screen.getByLabelText(COMPOSER_LABEL), 'Half typed');
    await fireEvent.press(within(thread).getByRole('button', { name: 'Questions (2)' }));
    expect(await screen.findByText('Are you closed on Mondays?')).toBeTruthy();
    await fireEvent.press(first(screen.getAllByRole('button', { name: 'Chat' })));
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('Half typed');
    await fireEvent.press(first(screen.getAllByRole('button', { name: 'Activity' })));
    expect(await screen.findByText('Read your upload for Oct 26 to Nov 1, 2026, 7 days.')).toBeTruthy();
  });

  test('wider screens keep the full header above the chat, with the switch under it', async () => {
    await renderAgent(meOf(ACCESS.member));
    const thread = await screen.findByTestId('chat-thread');
    expect(within(thread).queryByRole('heading', { name: 'TownwiseAI' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Location' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'TownwiseAI' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Questions (2)' })).toBeTruthy();
    expect(screen.getByText(COMPOSER_LABEL)).toBeTruthy();
  });
});

describe('view-as', () => {
  test('everything reads, every write control stays in place and disabled, with one read-only line', async () => {
    at(1280);
    const { chat } = await renderAgent(viewAsMe(ACCESS.member));
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    const input = screen.getByLabelText(COMPOSER_LABEL);
    expect(input.props.editable).toBe(false);
    disabled('Send');
    disabled('New chat');
    disabled('Which days last month were unusual?');
    disabled('Yes, closed Mondays');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, closed Mondays' }));
    // Reading is allowed: the target's past conversation opens, and its card's actions are disabled too.
    await fireEvent.press(screen.getByRole('button', { name: 'Conversations' }));
    disabled('Delete Earlier chat');
    await fireEvent.press(screen.getByRole('button', { name: /^Earlier chat/ }));
    expect(await screen.findByText('We close for the holidays.')).toBeTruthy();
    for (const name of ['Save note', 'Edit first', 'Not now']) {
      disabled(name);
      await fireEvent.press(screen.getByRole('button', { name }));
    }
    expect(chat.turns).toHaveLength(0);
    expect(chat.writes).toHaveLength(0);
    expect(screen.getAllByText('Read-only while viewing as gm@example.org.')).toHaveLength(1);
  });
});

describe('the portal’s client (spec 4.3)', () => {
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
    const { router } = await renderApp('/locations/l1/agent', api);
    return { api, router };
  }

  test('a member removed meanwhile is routed to No access, not shown an error', async () => {
    const { router } = await refusedChat(meOf(ACCESS.member), meOf(ACCESS.removed));
    await waitFor(() => { expect(router.getPathname()).toBe('/no-access'); });
  });

  test('a view-as grant that expired meanwhile lands staff on the console', async () => {
    const { router } = await refusedChat(viewAsMe(ACCESS.member), staffMe());
    await waitFor(() => { expect(router.getPathname()).toBe('/admin'); });
  });

  test('a note saved from a card reads the organization again on leaving, so Locations shows the new count', async () => {
    const { chat, portal } = await renderAgent(meOf(ACCESS.member));
    await fireEvent.press(await screen.findByRole('button', { name: 'Conversations' }));
    await fireEvent.press(screen.getByRole('button', { name: /^Earlier chat/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Saved to Notes.')).toBeTruthy();
    expect(chat.writes.map((write) => write.path)).toEqual([`/api/org/locations/l1/chat/c1/proposals/${PROPOSAL_ID}`]);
    const reads = portal.calls.filter((call) => call.path === '/api/org').length;
    portal.org = orgOf('member', LOCATIONS.map((location) => (location.id === 'l1' ? { ...location, notesCount: 3 } : location)));
    await fireEvent.press(screen.getByRole('link', { name: 'Home' }));
    await waitFor(() => { expect(portal.calls.filter((call) => call.path === '/api/org').length).toBeGreaterThan(reads); });
  });
});

test('nothing goes to device storage', async () => {
  const { chat } = await renderAgent(meOf(ACCESS.member));
  const store = Object.values(SecureStore).filter((value) => jest.isMockFunction(value));
  expect(store).toContain(SecureStore.setItemAsync);
  for (const fn of store) fn.mockClear();
  await send('Hello');
  await act(() => {
    turn(chat).emit('text', { delta: 'Hi.' });
    turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(chat).end();
  });
  expect(await screen.findByText('Hi.')).toBeTruthy();
  for (const fn of store) expect(fn).not.toHaveBeenCalled();
});
