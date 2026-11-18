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
import { Dimensions, ScrollView, StyleSheet } from 'react-native';
import { act, cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { aboutDraft } from '../../src/chat/about';
import { resetDrafts } from '../../src/chat/drafts';
import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { localToday } from '../../src/portal/locations/dates';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { theme } from '../../src/theme';
import { CONVERSATION, fakeChatApi, PROPOSAL, PROPOSAL_ID, refusal as chatRefusal, SALES_STEP, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { ACCESS, fakePortalApi, LOCATIONS, locationOf, meOf, orgOf, refusal, staffMe, viewAsMe } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { PUBLISHED, serveAbout } from './about-fakes';

// P25 TownwiseAI on native (spec 16.3, D26): the chat page and its side panel inside the portal, against a fake of
// the chat and side panel routes. The Pillars: every tool call is a card and the Based on line comes from the
// cards (transparency); the How TownwiseAI works panel and each question's help line (explainability); "Leave out
// guest names" under the composer, view-as with every write disabled, nothing in device storage but the conversation
// the page closed on, an id and a time (privacy).

afterEach(async () => {
  await cleanup();
  // Drafts and the name outlive the page in memory, as they do between visits in one session.
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
  jest.restoreAllMocks();
});

const WINDOW = Dimensions.get('window');

function at(width: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width });
}

async function renderAgent(me: MeResponse, chat: FakeChatApi = fakeChatApi(), org = orgOf('member'), path = '/locations/l1/agent') {
  // F10: GET .../estimates/about, with no forecast unless the test served another answer.
  if (!('about' in chat)) serveAbout(chat);
  const portal = fakePortalApi({ me, org, fallback: chat });
  const rendered = await renderApp(path, portal);
  await screen.findByRole('heading', { name: 'TownwiseAI' });
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

/** Opens Questions and activity: the column from 1024px, the sheet below. */
async function openPanel(): Promise<ReturnType<typeof screen.getByTestId>> {
  await fireEvent.press(await screen.findByRole('button', { name: /^Questions and activity/ }));
  return screen.findByTestId('agent-side');
}

async function openEarlierChat(): Promise<void> {
  await fireEvent.press(await screen.findByRole('button', { name: 'History' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
  await screen.findByText('We close for the holidays.');
}

describe('an empty conversation', () => {
  test('names the location, says what TownwiseAI reads, offers chips, and keeps the privacy line under the composer', async () => {
    await renderAgent(meOf(ACCESS.member));
    expect(await screen.findByRole('heading', { name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
    expect(screen.getByText('It reads your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data, and shows you each thing it reads. It suggests notes; you decide what’s saved.')).toBeTruthy();
    expect(screen.getByText('Leave out guest names. TownwiseAI answers from your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Which days last month were unusual?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^What’s coming up in \w+ in Hanover\?$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /forecast/i })).toBeNull();
    // No log until the first message.
    expect(screen.queryByTestId('chat-thread')).toBeNull();
  });

  test('an Ask chip sends at once; a Tell chip fills the composer and sends nothing', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await fireEvent.press(await screen.findByRole('button', { name: 'We’re closed on …' }));
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('We’re closed on ');
    expect(chat.turns).toHaveLength(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Which days last month were unusual?' }));
    expect(turn(chat).body).toEqual({ content: 'Which days last month were unusual?' });
    // What the person was typing stays in the composer, which now sits under the thread.
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('We’re closed on ');
    expect(within(await screen.findByTestId('chat-thread')).queryByLabelText(COMPOSER_LABEL)).toBeNull();
  });

  test('with no sales yet it says what TownwiseAI can use, and asks what to upload', async () => {
    const org = orgOf('member', [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })]);
    await renderAgent(meOf(ACCESS.member), fakeChatApi(), org);
    expect(await screen.findByText('You haven’t uploaded sales yet, so TownwiseAI can only use your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What should I upload?' })).toBeTruthy();
  });

  test('with every upload turned off it says so and points to Your data, not to uploading', async () => {
    const org = orgOf('member', [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, { offDayCount: 10 })]);
    await renderAgent(meOf(ACCESS.member), fakeChatApi(), org);
    expect(await screen.findByText(/^Every sales upload for this location is turned off, so TownwiseAI can only use your notes, .* Turn one back on in Your data\.$/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Your data' })).toBeTruthy();
    expect(screen.queryByText(/You haven’t uploaded sales yet/)).toBeNull();
  });

  test('a town Townwise hasn’t researched is never named as a source', async () => {
    at(1280);
    const org = orgOf('member', [locationOf('l1', 'Main Street Bar', { townId: null, name: 'Hanover', state: 'NH' })]);
    await renderAgent(meOf(ACCESS.member), fakeChatApi(), org);
    expect(await screen.findByText('You haven’t uploaded sales yet, so TownwiseAI can only use your notes, the town calendar and what your team added on Your data.')).toBeTruthy();
    // With no sales yet, no line claims TownwiseAI answers from them.
    expect(screen.getByText('Leave out guest names. TownwiseAI answers from your notes, the town calendar and what your team added on Your data.')).toBeTruthy();
    const side = await openPanel();
    await fireEvent.press(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
    expect(within(side).getByText('It reads your notes, the town calendar and what your team added on Your data, and shows you each thing it reads.')).toBeTruthy();
    expect(await within(side).findByText('Townwise has no forecast for this location yet, so TownwiseAI answers from your notes, the town calendar and what your team added on Your data.')).toBeTruthy();
    expect(screen.queryByText(/town profile/)).toBeNull();
    expect(screen.queryByText(/(answers from|reads) your sales/)).toBeNull();
  });
});

describe('a reply', () => {
  test('shows Working for with no Thinking… line, its timeline closed until pressed, then a running card, then text; open, it stays open as Worked for when done, with a Based on line from them', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await send('How was December?');
    expect(screen.getByText('How was December?')).toBeTruthy();
    expect(screen.getByText('Working for 0s')).toBeTruthy();
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(screen.queryByText('TownwiseAI is thinking…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await act(() => { turn(chat).emit('thinking', { delta: 'Weighing the weekend.' }); });
    const working = await screen.findByRole('button', { name: /^Working for \d+ seconds?$/ });
    expect(working.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('Weighing the weekend.')).toBeNull();
    await fireEvent.press(working);
    expect(screen.getByText('Weighing the weekend.')).toBeTruthy();
    expect(screen.queryByText('Thinking…')).toBeNull();
    await act(() => { turn(chat).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: SALES_STEP.input, result: null }); });
    expect(screen.getByText('Reading')).toBeTruthy();
    expect(screen.getByText('your sales for Dec 1 to Dec 31, 2025')).toBeTruthy();
    await act(() => {
      turn(chat).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
      turn(chat).emit('text', { delta: 'December was steady.' });
      turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0.01 });
      turn(chat).end();
    });
    expect(await screen.findByText('December was steady.')).toBeTruthy();
    expect(screen.queryByText(/^Working for/)).toBeNull();
    expect(screen.getByText('Based on your sales from Dec 1 to Dec 31, 2025.')).toBeTruthy();
    // Still open under Worked for: the summary and the row show, and the row opens to what it read.
    const worked = screen.getByRole('button', { name: /^Worked for \d+ seconds?$/ });
    expect(worked.props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Weighing the weekend.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Read your sales for Dec 1 to Dec 31, 2025. 31 days: guests on 31, net sales on 30' }));
    expect(screen.getByText('Days with net sales')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  test('a stopped reply keeps what arrived, says it wasn’t saved, and Try again sends the message again', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await send('Hello');
    await act(() => {
      turn(chat).emit('conversation', { id: 'c2', title: 'Hello', turnId: 'turn-1' });
      turn(chat).emit('text', { delta: 'Half a rep' });
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped. Your message and this reply weren’t saved.')).toBeTruthy();
    expect(screen.getByText('Half a rep')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(chat.turns).toHaveLength(2);
    expect(turn(chat).body).toEqual({ content: 'Hello' });
    expect(screen.queryByText('Half a rep')).toBeNull();
  });

  test('shows exactly three next questions under the newest settled reply only, the model’s when given', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await send('How was December?');
    const model = ['Show December as a chart', 'Compare December with November', 'Which December days were slow?'];
    await act(() => {
      turn(chat).emit('text', { delta: 'December was steady.' });
      turn(chat).emit('suggestions', { id: 'toolu_test_0009', prompts: model });
    });
    // Not while it streams. (A plain View isn't an accessibility element on native, so the chips are found by name.)
    for (const prompt of model) expect(screen.queryByRole('button', { name: prompt })).toBeNull();
    await act(() => {
      turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(chat).end();
    });
    for (const prompt of model) expect(await screen.findByRole('button', { name: prompt })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show that as a chart' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Which December days were slow?' }));
    expect(turn(chat).body).toEqual({ content: 'Which December days were slow?' });
    for (const prompt of model) expect(screen.queryByRole('button', { name: prompt })).toBeNull();
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
    // Held while the reply works (owner, 2026-11-18): the card shows once it ends.
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
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

  test('a proposal’s event name (D49) shows on the card, fills Edit first’s Event name, and its save sends it', async () => {
    const { chat } = await renderAgent(meOf(ACCESS.member));
    await send('Alumni weekend');
    const named = { ...PROPOSAL, kind: 'private_event', effect: 'more_guests', expectedGuests: 120, detail: null, title: 'Alumni weekend dinner' };
    await act(() => {
      turn(chat).emit('conversation', { id: 'c2', title: 'Alumni weekend' });
      turn(chat).emit('proposal', { id: PROPOSAL_ID, proposal: named });
      turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(chat).end();
    });
    expect(await screen.findByText('Event name')).toBeTruthy();
    expect(screen.getByText('Alumni weekend dinner')).toBeTruthy();
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Edit first' }).props.accessibilityState).not.toMatchObject({ disabled: true }); });
    await fireEvent.press(screen.getByRole('button', { name: 'Edit first' }));
    expect(screen.getByLabelText('Event name (optional)').props.value).toBe('Alumni weekend dinner');
    await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Saved to Notes, with your changes.')).toBeTruthy();
    expect(chat.writes.at(-1)).toMatchObject({ body: { action: 'save', note: { title: 'Alumni weekend dinner' } } });
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
    await openEarlierChat();
    expect(screen.getByText('Last December you were open every day.')).toBeTruthy();
    // Stored times: 12 seconds from the person's message to the reply's end.
    await fireEvent.press(screen.getByRole('button', { name: 'Worked for 12 seconds' }));
    expect(screen.getByText('Checked December against the notes.')).toBeTruthy();
    expect(screen.getByText('Based on your sales from Dec 1 to Dec 31, 2025.')).toBeTruthy();
    expect(screen.getByText('Proposed note')).toBeTruthy();
    // The header names no conversation (its title shows only in History).
    expect(screen.queryByText('Earlier chat')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'History' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Delete Earlier chat' }));
    expect(await screen.findByText('TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => { expect(screen.queryByText('We close for the holidays.')).toBeNull(); });
    expect(chat.writes).toEqual([{ method: 'DELETE', path: '/api/org/locations/l1/chat/c1', body: undefined }]);
    expect(screen.queryByText('New conversation')).toBeNull();
    // Back to the landing.
    expect(screen.getByRole('heading', { name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
  });

  test('the person’s bubble is rounded (D26) and the proposal card stays square', async () => {
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    const card = (await screen.findByText('Proposed note')).parent;
    expect(StyleSheet.flatten(card?.props.style)).toMatchObject({ borderWidth: 1, borderRadius: 0 });
    expect(StyleSheet.flatten(screen.getByTestId('user-bubble').props.style)).toMatchObject({ borderWidth: 1, borderRadius: 16 });
  });

  test('the person’s files show as chips over the bubble, with no thumbnail; the composer has no + (D20, D36)', async () => {
    const chat = fakeChatApi();
    chat.conversation = {
      ...CONVERSATION,
      messages: [
        {
          ...CONVERSATION.messages[0],
          attachments: [
            { ref: 'f_0123456789abcdef01234567', kind: 'picture', name: 'patio.png', state: 'on' },
            { ref: 'f_76543210fedcba9876543210', kind: 'pdf', name: null, state: 'gone' },
          ],
        },
        CONVERSATION.messages[1],
      ],
    };
    await renderAgent(meOf(ACCESS.member), chat);
    await openEarlierChat();
    const files = screen.getByLabelText('Files attached');
    expect(within(files).getByRole('link', { name: 'patio.png, Picture. Open on Your data' })).toBeTruthy();
    expect(within(files).getByText('No longer on Your data')).toBeTruthy();
    expect(within(files).queryByRole('link', { name: /PDF/ })).toBeNull();
    expect(screen.queryByTestId('attachment-thumb')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    // Nothing asked for the picture's item or bytes.
    expect(chat.writes.filter((write) => write.path.includes('/files/'))).toEqual([]);
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
    // The chips wait for next month too, and the 80% line gives way to the sentence.
    disabled('Which days last month were unusual?');
    expect(screen.queryByText(/^Most of November’s budget is used/)).toBeNull();
  });

  test('shows the 80% budget line above the composer', async () => {
    const chat = fakeChatApi();
    chat.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 17 } };
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('Most of November’s budget is used. TownwiseAI pauses when it runs out.')).toBeTruthy();
    expect(screen.getByLabelText(COMPOSER_LABEL)).toBeTruthy();
  });

  test('not found: a chat that answers 404 says the location wasn’t found, with no composer', async () => {
    const chat = fakeChatApi();
    chat.chatError = chatRefusal(404, 'not_found');
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('This location wasn’t found.')).toBeTruthy();
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

describe('the side panel', () => {
  test('is closed by default and opens as a column from 1024px and as a sheet below', async () => {
    at(1280);
    const { chat } = await renderAgent(meOf(ACCESS.member));
    // It reads its questions anyway, for the button's count.
    expect(chat.panelLoads).toBe(1);
    const toggle = await screen.findByRole('button', { name: 'Questions and activity (2)' });
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByTestId('agent-side')).toBeNull();
    await fireEvent.press(toggle);
    expect(await screen.findByTestId('agent-side')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Questions and activity (2)' }).props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.queryByRole('heading', { name: 'Questions and activity' })).toBeNull();
    await cleanup();
    jest.restoreAllMocks();
    // Below 1024px, a full-screen sheet with its heading and Close.
    at(800);
    await renderAgent(meOf(ACCESS.member));
    await fireEvent.press(await screen.findByRole('button', { name: 'Questions and activity (2)' }));
    expect(await screen.findByRole('heading', { name: 'Questions and activity' })).toBeTruthy();
    expect(within(screen.getByTestId('agent-side')).getByRole('heading', { name: 'Questions for you' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Questions and activity' })).toBeNull();
  });

  test('questions with what each answer does; an answer saves and says what it did', async () => {
    // The sheet below 1024px keeps the questions over the landing (from 1024px the column beside the landing leaves
    // them to it), so the panel's own heading, count and Planned tag show here.
    at(800);
    const { chat } = await renderAgent(meOf(ACCESS.member));
    const side = await openPanel();
    expect(within(side).getByRole('heading', { name: 'Questions for you' })).toBeTruthy();
    expect(await within(side).findByText('2 open')).toBeTruthy();
    expect(within(side).getByRole('heading', { name: 'Were you open on Sat, Jan 24, 2026?' })).toBeTruthy();
    expect(within(side).getByText('Only 1 guest was recorded. Saturdays usually have about 100.')).toBeTruthy();
    expect(within(side).getByText('Townwise treats this day as likely closed until you say. Yes saves a note that you were open with fewer guests, so the day counts. No saves a closure note for it. Something else lets you tell TownwiseAI in the chat.')).toBeTruthy();
    expect(within(side).getByRole('heading', { name: 'Were you closed Feb 1 to Feb 3, 2026?' })).toBeTruthy();
    expect(within(side).getByText('There are no sales for these 3 days.')).toBeTruthy();
    expect(within(side).getByText('TownwiseAI’s own research (unusual nights, town events it finds) is planned.')).toBeTruthy();

    await fireEvent.press(within(side).getByRole('button', { name: 'No, we were closed' }));
    expect(await within(side).findByText('Saved a note: Closure, Sat, Jan 24, 2026. TownwiseAI treats that day as closed.')).toBeTruthy();
    expect(chat.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/agent/questions/likely_closed_2026-01-24', body: { answer: 'closed' } }]);
    expect(within(side).getByText('1 open')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Questions and activity (1)' })).toBeTruthy();
    await fireEvent.press(within(side).getByRole('button', { name: 'Not sure' }));
    expect(await within(side).findByText('Got it. TownwiseAI won’t ask about these days again.')).toBeTruthy();
  });

  test('activity lists only real, dated events, and the budget shows as percent used', async () => {
    at(1280);
    await renderAgent(meOf(ACCESS.member));
    const side = await openPanel();
    expect(await within(side).findByText('Saved a note you approved: Closure, Nov 26, 2026.')).toBeTruthy();
    expect(within(side).getByText('Read your upload for Oct 26 to Nov 1, 2026, 7 days.')).toBeTruthy();
    expect(within(side).getByText('You said the data is missing for Jan 1 to Jan 2, 2026.')).toBeTruthy();
    // A kind this client doesn't know (forecast_made) shows as nothing.
    expect(within(side).getAllByText(/^(Saved|Read|You said)/)).toHaveLength(3);
    expect(within(side).getByText('November: 6% used. Resets Dec 1.')).toBeTruthy();
  });

  test('How TownwiseAI works says what it reads, that it can search the web, what it can’t see, that no forecast exists, and who receives the data', async () => {
    at(1280);
    await renderAgent(meOf(ACCESS.member));
    const side = await openPanel();
    await fireEvent.press(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
    expect(await within(side).findByText('Townwise has no forecast for this location yet, so TownwiseAI answers from your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data.')).toBeTruthy();
    for (const text of [
      'It reads your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data, and shows you each thing it reads.',
      'It can search the web for public facts about the town, such as an event’s dates or the weather, and lists the pages it used.',
      'It can’t see your staffing, your bookings unless you add them as notes, or guest names.',
      'It suggests notes; it never saves one without you.',
    ]) expect(within(side).getByText(text)).toBeTruthy();
    expect(within(side).getByText(/Your messages and the data it reads go to Anthropic/)).toBeTruthy();
  });

  test('F10: once a forecast is published, what it reads and the forecast line say so by themselves, from estimates/about', async () => {
    at(1280);
    const chat = serveAbout(fakeChatApi(), PUBLISHED);
    await renderAgent(meOf(ACCESS.member), chat);
    const reads = 'your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover, Townwise’s forecast and what your team added on Your data';
    expect(await screen.findByText(`Leave out guest names. TownwiseAI answers from ${reads}.`)).toBeTruthy();
    const side = await openPanel();
    await fireEvent.press(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
    expect(within(side).getByText(`It reads ${reads}, and shows you each thing it reads.`)).toBeTruthy();
    expect(within(side).getByText('TownwiseAI also reads the forecast Townwise published: Townwise demand model v9, trained on sales exports you sent Townwise from Jan 1, 2025 to Oct 21, 2026, made Nov 1, 2026.')).toBeTruthy();
    expect(within(side).queryByText(/no forecast/)).toBeNull();
    expect(chat.aboutLoads).toBe(1);
  });

  test('F10: if estimates/about can’t be read it claims nothing about a forecast, and Try again reads it again', async () => {
    at(1280);
    const chat = serveAbout(fakeChatApi(), chatRefusal(503, 'unavailable'));
    await renderAgent(meOf(ACCESS.member), chat);
    const side = await openPanel();
    await fireEvent.press(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
    expect(await within(side).findByText('Couldn’t check whether Townwise has a forecast for this location.')).toBeTruthy();
    expect(screen.queryByText(/Townwise’s forecast/)).toBeNull();
    serveAbout(chat, PUBLISHED);
    await fireEvent.press(within(side).getByRole('button', { name: 'Try again' }));
    expect(await within(side).findByText(/^TownwiseAI also reads the forecast Townwise published/)).toBeTruthy();
    expect(chat.aboutLoads).toBe(2);
  });

  test('F10: How Townwise estimates opens the model card in a sheet, and Close shuts it', async () => {
    at(1280);
    await renderAgent(meOf(ACCESS.member));
    const side = await openPanel();
    await fireEvent.press(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
    expect(screen.queryByRole('heading', { name: 'How Townwise estimates' })).toBeNull();
    await fireEvent.press(within(side).getByRole('button', { name: 'How Townwise estimates' }));
    expect(await screen.findByRole('heading', { name: 'How Townwise estimates' })).toBeTruthy();
    expect(await screen.findByText('Townwise has no forecast for Main Street Bar yet. Home and TownwiseAI use your history and Hanover’s calendar until it does.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'How Townwise estimates' })).toBeNull();
  });

  test('F3: a stored file Townwise read shows with its dates and day count, never a name', async () => {
    at(1280);
    const chat = fakeChatApi();
    chat.panel = {
      questions: [],
      activity: [{ at: '2026-11-02T15:00:00.000Z', kind: 'file_processed', fileId: '0000000000000000000000f1', firstDate: '2026-10-19', lastDate: '2026-10-25', dayCount: 7 }],
    };
    await renderAgent(meOf(ACCESS.member), chat);
    const side = await openPanel();
    expect(await within(side).findByText('Read your file for Oct 19 to Oct 25, 2026, 7 days.')).toBeTruthy();
  });

  test('the side panel loads even while TownwiseAI is off, and an empty panel says so', async () => {
    at(1280);
    const chat = fakeChatApi();
    chat.summary = { ...SUMMARY, enabled: false };
    chat.panel = { questions: [], activity: [] };
    await renderAgent(meOf(ACCESS.member), chat);
    expect(await screen.findByText('TownwiseAI isn’t turned on yet.')).toBeTruthy();
    const side = await openPanel();
    expect(await within(side).findByText('No questions right now.')).toBeTruthy();
    expect(within(side).getByText('Nothing yet. Upload sales or save a note and it shows here.')).toBeTruthy();
  });

  test('a panel that can’t load says so with Try again, and reads again', async () => {
    at(1280);
    const chat = fakeChatApi();
    chat.panelError = refusal(503, 'unavailable');
    await renderAgent(meOf(ACCESS.member), chat);
    const side = await openPanel();
    expect(await within(side).findByText('Couldn’t load TownwiseAI’s questions.')).toBeTruthy();
    chat.panelError = null;
    await fireEvent.press(first(within(side).getAllByRole('button', { name: 'Try again' })));
    // Read, they show under the landing's chips, and the column beside it leaves them out.
    expect(await within(await screen.findByTestId('chat-landing-questions')).findByText('Were you open on Sat, Jan 24, 2026?')).toBeTruthy();
    expect(within(side).queryByText('Couldn’t load TownwiseAI’s questions.')).toBeNull();
    expect(within(side).queryByText('Were you open on Sat, Jan 24, 2026?')).toBeNull();
  });
});

describe('phones', () => {
  test('at 375px nothing scrolls above the chat header, and the panel is a sheet; the chat keeps its state', async () => {
    at(375);
    await renderAgent(meOf(ACCESS.member));
    const landing = await screen.findByTestId('chat-landing');
    expect(screen.queryByText(/^Welcome back/)).toBeNull();
    expect(screen.queryByText('Main Street Bar, Hanover, NH')).toBeNull();
    const questions = screen.getByRole('button', { name: 'Questions and activity (2)' });
    expect(within(landing).queryByRole('button', { name: 'Questions and activity (2)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
    // The composer's label is the input's name, with nothing drawn.
    expect(screen.queryByText(COMPOSER_LABEL)).toBeNull();
    await fireEvent.changeText(screen.getByLabelText(COMPOSER_LABEL), 'Half typed');
    await fireEvent.press(questions);
    // In the sheet (the landing shows the same question under its chips).
    expect(await within(await screen.findByTestId('agent-side')).findByText('Were you open on Sat, Jan 24, 2026?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('Half typed');
    // After the first send the header stays above the thread, and the composer stays under it.
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    const thread = await screen.findByTestId('chat-thread');
    expect(within(thread).queryByRole('button', { name: 'Questions and activity (2)' })).toBeNull();
    expect(within(thread).queryByLabelText(COMPOSER_LABEL)).toBeNull();
  });

  test('wider screens have no page header either: one hidden h1, no switcher, the chat header on top', async () => {
    await renderAgent(meOf(ACCESS.member));
    await screen.findByTestId('chat-landing');
    expect(screen.queryByRole('heading', { name: /^Welcome back/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'TownwiseAI' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Questions and activity (2)' })).toBeTruthy();
  });
});

test('while the page loads it is a skeleton of the page, with Loading TownwiseAI… only as its status line (owner, 2026-11-18)', async () => {
  const chat = fakeChatApi();
  let answer: (() => void) | null = null;
  chat.reads['/api/org/locations/l1/chat'] = () => new Promise((resolve) => { answer = () => { resolve(chat.summary); }; });
  await renderAgent(meOf(ACCESS.member), chat);
  const skeleton = await screen.findByTestId('skeleton-agent');
  expect(StyleSheet.flatten(skeleton.props.style)).toMatchObject({ flex: 1 });
  expect(within(skeleton).getByRole('status').props.children).toBe('Loading TownwiseAI…');
  // The shapes are hidden from screen readers: the header's controls, the landing's column, composer and suggestions.
  for (const id of ['skeleton-chat-header', 'skeleton-agent-landing', 'skeleton-agent-composer', 'skeleton-agent-suggestions']) {
    expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId(id, { includeHiddenElements: true })).toBeTruthy();
  }
  expect(StyleSheet.flatten(screen.getByTestId('skeleton-agent-landing', { includeHiddenElements: true }).props.style))
    .toMatchObject({ flexGrow: 1, justifyContent: 'center', maxWidth: 760 });
  // The landing's own words, as bars in its own type, so its rows take the lines the landing's will; hidden, never drawn.
  expect(screen.queryByText(/^Ask TownwiseAI about/)).toBeNull();
  const words = screen.getByText(/^Ask TownwiseAI about/, { includeHiddenElements: true });
  expect(StyleSheet.flatten(words.props.style)).toMatchObject({ color: 'transparent', backgroundColor: theme.color.raised });
  expect(screen.getAllByTestId('skeleton-chip', { includeHiddenElements: true }).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  await act(async () => { answer?.(); await Promise.resolve(); });
  expect(await screen.findByTestId('chat-landing')).toBeTruthy();
  expect(screen.queryByTestId('skeleton-agent', { includeHiddenElements: true })).toBeNull();
});

describe('the docked composer', () => {
  // The thread runs the full height and scrolls under the composer, which is laid over its bottom edge; the room the
  // thread keeps at its end follows the dock's measured height, and the dock growing or shrinking moves the end,
  // never the pin. Heights below are the thread's content with that room, in a 600pt view.
  const VIEW = 600;

  async function dockAt(height: number): Promise<void> {
    await fireEvent(screen.getByTestId('chat-dock'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 760, height } } });
  }

  async function scrolled(y: number, height: number): Promise<void> {
    await fireEvent.scroll(screen.getByTestId('chat-thread'), {
      nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 760, height }, layoutMeasurement: { width: 760, height: VIEW } },
    });
  }

  /** The person drags the thread to `y` (a drag's scroll events come between its begin and end). */
  async function dragged(y: number, height: number): Promise<void> {
    const thread = screen.getByTestId('chat-thread');
    await fireEvent(thread, 'scrollBeginDrag');
    await scrolled(y, height);
    await fireEvent(thread, 'scrollEndDrag');
  }

  async function contentAt(height: number): Promise<void> {
    await fireEvent(screen.getByTestId('chat-thread'), 'contentSizeChange', 760, height);
  }

  function expectThreadEnd(paddingBottom: number): void {
    expect(StyleSheet.flatten(screen.getByTestId('chat-thread').props.contentContainerStyle)).toMatchObject({ paddingBottom });
  }

  test('sits over the thread’s bottom edge, and the thread keeps room at its end as tall as the dock', async () => {
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    const thread = screen.getByTestId('chat-thread');
    const dock = screen.getByTestId('chat-dock');
    // A sibling laid over the thread, not a row under it; what it doesn't draw passes touches to the thread.
    expect(dock.parent).toBe(thread.parent);
    expect(StyleSheet.flatten(dock.props.style)).toMatchObject({ position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' });
    expect(within(dock).getByLabelText(COMPOSER_LABEL)).toBeTruthy();
    expectThreadEnd(16);
    await dockAt(120);
    expectThreadEnd(136);
    expect(screen.getByTestId('chat-thread').props.scrollIndicatorInsets).toEqual({ bottom: 120 });
    await dockAt(180);
    expectThreadEnd(196);
  });

  test('hides what scrolls under it from the box’s middle down, and under the whole dock once a line sits above the composer', async () => {
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    const skirt = screen.getByTestId('chat-dock-skirt');
    // 12 above the box, and half its 56: what passes shows above the box and at its top corners.
    expect(StyleSheet.flatten(skirt.props.style)).toMatchObject({
      position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, backgroundColor: theme.color.ground, pointerEvents: 'none',
    });
    // Drawn first in the dock, so the composer is drawn over it.
    expect(skirt.parent?.children[0]).toBe(skirt);
    await cleanup();

    const chat = fakeChatApi();
    chat.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 17 } };
    await renderAgent(meOf(ACCESS.member), chat);
    await openEarlierChat();
    expect(screen.getByText('Most of November’s budget is used. TownwiseAI pauses when it runs out.')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('chat-dock-skirt').props.style)).toMatchObject({ top: 0 });
  });

  test('a pinned thread follows the dock to its end; an unpinned one stays put, and only a reply growing shows Latest, above the dock', async () => {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    await dockAt(120);
    await contentAt(1136);
    await scrolled(1136 - VIEW, 1136);
    // A second line grows the dock: the pinned thread goes to its new end before it is drawn.
    toEnd.mockClear();
    await dockAt(180);
    expect(toEnd).toHaveBeenCalledWith({ animated: false });
    await contentAt(1196);
    await scrolled(1196 - VIEW, 1196);

    // The person scrolls up: unpinned, with nothing new below.
    await dragged(400, 1196);
    toEnd.mockClear();
    // The dock shrinks and grows: the thread stays where it is, and that is no reply growing.
    await dockAt(120);
    await contentAt(1136);
    await dockAt(240);
    await contentAt(1256);
    expect(toEnd).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
    // A reply grows below the view: Latest shows, 12 above the dock.
    await contentAt(1456);
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('chat-latest').props.style)).toMatchObject({ position: 'absolute', right: 0, bottom: 252 });
    await dockAt(120);
    expect(StyleSheet.flatten(screen.getByTestId('chat-latest').props.style)).toMatchObject({ bottom: 132 });
  });

  test('the dock shrinking under a pinned thread keeps it pinned, so a reply growing is followed, not flagged', async () => {
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    await dockAt(180);
    await contentAt(1196);
    await scrolled(1196 - VIEW, 1196);
    // The draft is sent and the box goes back to one line: the end moves up with the room, and the offset with it.
    await dockAt(120);
    await contentAt(1136);
    await scrolled(1136 - VIEW, 1136);
    await contentAt(1336);
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
  });

  test('the first reply to overflow a fresh thread is followed: its end is no scroll up, though the dock was measured after the pin last saw it', async () => {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    await renderAgent(meOf(ACCESS.member));
    await send('How was last week?');
    await screen.findByTestId('chat-thread');
    await dockAt(120);
    // The reply streams: not yet past the view, then just past it (the jump to its end lands 40 down).
    await contentAt(500 + 120);
    await contentAt(VIEW + 40);
    await scrolled(40, VIEW + 40);
    toEnd.mockClear();
    // More arrives: the thread is still pinned, so it goes to its end and shows no Latest.
    await contentAt(VIEW + 400);
    expect(toEnd).toHaveBeenCalledWith({ animated: false });
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
    // A scroll up from that end still unpins.
    await scrolled(VIEW + 400 - VIEW, VIEW + 400);
    await dragged(300, VIEW + 400);
    await contentAt(VIEW + 600);
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
  });

  test('follows every frame of the timeline opening and closing, the shrink heard before its scroll included; a scroll up stops it; a send goes to the end (owner, 2026-11-18)', async () => {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    await dockAt(120);
    await contentAt(1120);
    await scrolled(1120 - VIEW, 1120);
    for (let height = 1140; height <= 1320; height += 20) {
      toEnd.mockClear();
      await contentAt(height);
      expect(toEnd).toHaveBeenCalledWith({ animated: false });
      await scrolled(height - VIEW, height);
    }
    // Closing: the height is heard first, then the offset pulled back to the new end.
    for (let height = 1300; height >= 1120; height -= 20) {
      await contentAt(height);
      await scrolled(height - VIEW, height);
    }
    toEnd.mockClear();
    await contentAt(1400);
    expect(toEnd).toHaveBeenCalledWith({ animated: false });
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
    await scrolled(1400 - VIEW, 1400);
    // A scroll up: nothing pulls the view back as the reply grows.
    await dragged(500, 1400);
    toEnd.mockClear();
    await contentAt(1500);
    expect(toEnd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
    // A send goes to the end.
    await fireEvent.changeText(screen.getByLabelText(COMPOSER_LABEL), 'And January?');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(toEnd).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
  });

  test('a thread that first overflows as the timeline opens stays pinned through a scroll event read mid-growth; a drag, and its momentum, unpin', async () => {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    await renderAgent(meOf(ACCESS.member));
    await send('How was last week?');
    await screen.findByTestId('chat-thread');
    await dockAt(120);
    await contentAt(500);
    // The timeline opens: the thread passes the view, and the scroll event read mid-growth sits short of the end.
    await contentAt(VIEW + 85);
    await scrolled(85, VIEW + 146);
    toEnd.mockClear();
    await contentAt(VIEW + 400);
    expect(toEnd).toHaveBeenCalledWith({ animated: false });
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
    await scrolled(400, VIEW + 400);
    // The momentum a flick leaves is the person's too.
    const thread = screen.getByTestId('chat-thread');
    await fireEvent(thread, 'momentumScrollBegin');
    await scrolled(200, VIEW + 400);
    await fireEvent(thread, 'momentumScrollEnd');
    toEnd.mockClear();
    await contentAt(VIEW + 600);
    expect(toEnd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
  });

  test('the dock shrinking under an unpinned thread leaves it unpinned: a small scroll up near the end is still a scroll up', async () => {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    await dockAt(180);
    await contentAt(1196);
    await scrolled(1196 - VIEW, 1196);
    // The person scrolls up 60 from the end.
    await dragged(1196 - VIEW - 30, 1196);
    await dragged(1196 - VIEW - 60, 1196);
    // They delete two lines of the draft: the dock and the room under the thread shrink by 60, and the offset, now at
    // the end, stays put (no scroll event).
    await dockAt(120);
    await contentAt(1136);
    // Another 10 up, then the reply grows: it is flagged, not followed.
    await dragged(1136 - VIEW - 10, 1136);
    toEnd.mockClear();
    await contentAt(1336);
    expect(toEnd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
  });
});

describe('F7: ?about=YYYY-MM-DD', () => {
  test('fills the composer with the day and sends nothing; New chat and typing leave the person’s text alone', async () => {
    const date = localToday();
    const { chat } = await renderAgent(meOf(ACCESS.member), fakeChatApi(), orgOf('member'), `/locations/l1/agent?about=${date}`);
    const expected = aboutDraft(date, localToday());
    expect(expected).toMatch(/^Tell me about \w{3}, \w{3} \d{1,2}$/);
    await waitFor(() => { expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe(expected); });
    expect(chat.turns).toHaveLength(0);
    await fireEvent.changeText(screen.getByLabelText(COMPOSER_LABEL), '');
    await fireEvent.press(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('');
    expect(chat.turns).toHaveLength(0);
  });

  test('ignores a malformed or out-of-range date', async () => {
    for (const about of ['2026-02-30', 'tomorrow', '2009-12-31', '2999-01-01']) {
      await renderAgent(meOf(ACCESS.member), fakeChatApi(), orgOf('member'), `/locations/l1/agent?about=${about}`);
      expect(await screen.findByLabelText(COMPOSER_LABEL)).toBeTruthy();
      expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('');
      await cleanup();
    }
  });
});

describe('view-as', () => {
  test('everything reads, every write control stays in place and disabled, with one read-only line', async () => {
    at(1280);
    const api = fakeChatApi();
    api.profile = { displayName: null, askName: false };
    await renderAgent(viewAsMe(ACCESS.member), api);
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    const input = screen.getByLabelText(COMPOSER_LABEL);
    expect(input.props.editable).toBe(false);
    disabled('Send');
    disabled('New chat');
    disabled('Which days last month were unusual?');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await openPanel();
    disabled('No, we were closed');
    // Beside the landing, the cards are under its chips; the panel's column leaves them out.
    await fireEvent.press(within(screen.getByTestId('chat-landing-questions')).getByRole('button', { name: 'No, we were closed' }));
    // Reading is allowed: the target's past conversation opens, and its actions are disabled too.
    await fireEvent.press(screen.getByRole('button', { name: 'History' }));
    disabled('Delete Earlier chat');
    disabled('Rename Earlier chat');
    await fireEvent.press(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    expect(await screen.findByText('We close for the holidays.')).toBeTruthy();
    for (const name of ['Save note', 'Edit first', 'Not now', 'Edit', 'Regenerate', 'Helpful', 'Not helpful']) {
      disabled(name);
      await fireEvent.press(screen.getByRole('button', { name }));
    }
    expect(api.turns).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
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
    await waitFor(() => { expect(router.getPathname()).toBe('/admin/overview'); });
  });

  test('a note saved from a card reads the organization again on leaving, so Locations shows the new count', async () => {
    const { chat, portal } = await renderAgent(meOf(ACCESS.member));
    await openEarlierChat();
    await fireEvent.press(await screen.findByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Saved to Notes.')).toBeTruthy();
    expect(chat.writes.map((write) => write.path)).toEqual([`/api/org/locations/l1/chat/c1/proposals/${PROPOSAL_ID}`]);
    const reads = portal.calls.filter((call) => call.path === '/api/org').length;
    portal.org = orgOf('member', LOCATIONS.map((location) => (location.id === 'l1' ? { ...location, notesCount: 3 } : location)));
    await fireEvent.press(screen.getByRole('link', { name: 'Home' }));
    await waitFor(() => { expect(portal.calls.filter((call) => call.path === '/api/org').length).toBeGreaterThan(reads); });
  });
});

test('nothing goes to device storage while the page is open; leaving it keeps only the conversation’s id and a time', async () => {
  const { chat } = await renderAgent(meOf(ACCESS.member));
  const store = Object.values(SecureStore).filter((value) => jest.isMockFunction(value));
  expect(store).toContain(SecureStore.setItemAsync);
  for (const fn of store) fn.mockClear();
  await send('Hello');
  await fireEvent.changeText(screen.getByLabelText(COMPOSER_LABEL), 'Half typed');
  await act(() => {
    turn(chat).emit('conversation', { id: 'c2', title: 'Hello', turnId: 'turn-1' });
    turn(chat).emit('text', { delta: 'Hi.' });
    turn(chat).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(chat).end();
  });
  expect(await screen.findByText('Hi.')).toBeTruthy();
  for (const fn of store) expect(fn).not.toHaveBeenCalled();
  await cleanup();
  const kept = jest.mocked(SecureStore.setItemAsync).mock.calls;
  expect(kept).toHaveLength(1);
  expect(kept[0]?.[0]).toMatch(/^townwise\.chatReturn\./);
  expect(Object.keys(JSON.parse(kept[0]?.[1] ?? '{}') as object).sort()).toEqual(['conversationId', 'leftAt']);
  for (const fn of store) expect(JSON.stringify(fn.mock.calls)).not.toMatch(/Hello|Half typed|Hi\./);
});
