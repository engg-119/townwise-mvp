jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as SecureStore from 'expo-secure-store';
import { Dimensions } from 'react-native';
import { act, cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import { fakeChatApi, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { serveAbout } from './about-fakes';

// TownwiseAI's questions on native (spec P25; contract section 7): ?panel=questions (Home's link) opens the row under the chips
// on phones and the column from 641px, the questions show inline on the landing, and Something else… sends its message
// to the chat before answering `other`. Device storage holds at most the conversation the page closed on (an id and a
// time, src/chat/lastChat.ts), never the words.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[] };
  /** D71: a private event's question, and the answer a count gets. */
  partyGuests: { questions: unknown[]; answer: { questionId: string; response: unknown } };
};

const GAP_HEADING = 'Were you closed May 12 to May 13, 2026?';
const WORDS = 'A private party had the whole place.';
const MESSAGE = `About May 12 to May 13, 2026 (no sales on these 2 days; those days of the week usually have about 100 guests): ${WORDS}`;

afterEach(async () => {
  await cleanup();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
  jest.restoreAllMocks();
});

const WINDOW = Dimensions.get('window');

function at(width: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width });
}

async function renderAgent(path = '/locations/l1/agent', panel: unknown = fixture.panel) {
  const chat = fakeChatApi();
  chat.panel = panel;
  serveAbout(chat);
  const portal = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: chat });
  const rendered = await renderApp(path, portal);
  await screen.findByRole('heading', { name: 'TownwiseAI' });
  return { chat, ...rendered };
}

function turn(api: FakeChatApi): LiveTurn {
  const live = api.turns.at(-1);
  if (live === undefined) throw new Error('no turn');
  return live;
}

// An independent browser review, 2026-11-18: on a phone Home's link opened the row with the panel's sections above
// the questions, which sat off screen.
test('?panel=questions opens the row under the chips on a phone, Questions for you first, then Suggested rules (D46), and drops the parameter', async () => {
  at(375);
  const { router } = await renderAgent('/locations/l1/agent?panel=questions');
  const side = await screen.findByTestId('agent-side');
  expect(screen.getByRole('button', { name: 'Questions and activity (9)' }).props.accessibilityState).toMatchObject({ expanded: true });
  await within(side).findByRole('heading', { name: 'Questions for you (2)' });
  const headings = within(side).getAllByRole('heading').map((heading) => heading.props.children as unknown);
  expect(headings[0]).toBe('Questions for you (2)');
  expect(headings).toContain('Suggested rules');
  // Drawn once: the landing's own questions, in the row instead of under it; the panel still leaves them out.
  expect(screen.getAllByRole('heading', { name: /^Questions for you/ })).toHaveLength(1);
  expect(headings).not.toContain('Questions for you');
  await waitFor(() => { expect(router.getSearchParams().panel).toBeUndefined(); });
  expect(router.getPathname()).toBe('/locations/l1/agent');
});

test('?panel=questions opens the column from 641px', async () => {
  at(1280);
  await renderAgent('/locations/l1/agent?panel=questions');
  expect(await screen.findByTestId('agent-side')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Questions and activity' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Questions and activity (9)' }).props.accessibilityState).toMatchObject({ expanded: true });
});

test('a card’s message from the new chat page opens the conversation, and the open row goes with the landing', async () => {
  at(375);
  const { chat } = await renderAgent('/locations/l1/agent?panel=questions');
  const landing = await screen.findByTestId('chat-landing');
  await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
  expect(screen.getByTestId('agent-side')).toBeTruthy();
  const gapOther = within(landing).getAllByRole('button', { name: 'Something else…' })[1];
  if (gapOther === undefined) throw new Error('no Something else… on the gap');
  await fireEvent.press(gapOther);
  await fireEvent.changeText(within(landing).getByLabelText('Tell TownwiseAI in your own words'), WORDS);
  await fireEvent.press(within(landing).getByRole('button', { name: 'Send to TownwiseAI' }));
  await waitFor(() => { expect(chat.turns).toHaveLength(1); });
  await act(() => {
    turn(chat).emit('conversation', { id: 'c9', title: 'A party', userNodeId: 'u9', replyNodeId: 'a9', parentId: null });
  });
  expect(screen.getByText(MESSAGE)).toBeTruthy();
  expect(screen.queryByTestId('chat-panel-row')).toBeNull();
  expect(screen.queryByTestId('agent-side')).toBeNull();
  await act(() => {
    turn(chat).emit('done', { stopReason: 'end_turn', leafId: 'a9' });
    turn(chat).end();
  });
  await waitFor(() => { expect(chat.writes.map((write) => write.body)).toEqual([{ answer: 'other' }]); });
});

test('the landing shows the questions under the chips, and Something else… sends its message, then answers other', async () => {
  at(375);
  const { chat } = await renderAgent();
  const landing = await screen.findByTestId('chat-landing');
  expect(await within(landing).findByRole('heading', { name: 'Questions for you (2)' })).toBeTruthy();
  expect(within(landing).getByText('Only 1 guest was recorded. Saturdays usually have about 100.')).toBeTruthy();
  // The cards in the API's order: the likely-closed day, then the gap.
  expect(within(landing).getAllByRole('heading').map((heading) => heading.props.children as unknown).slice(-2)).toEqual([
    'Were you open on Sat, May 23, 2026?', GAP_HEADING,
  ]);
  const gapOther = () => {
    const button = within(landing).getAllByRole('button', { name: 'Something else…' })[1];
    if (button === undefined) throw new Error('no Something else… on the gap');
    return button;
  };
  expect(gapOther().props.accessibilityState).toMatchObject({ expanded: false });
  await fireEvent.press(gapOther());
  expect(gapOther().props.accessibilityState).toMatchObject({ expanded: true });
  await fireEvent.changeText(within(landing).getByLabelText('Tell TownwiseAI in your own words'), WORDS);
  await fireEvent.press(within(landing).getByRole('button', { name: 'Send to TownwiseAI' }));
  await waitFor(() => { expect(chat.turns).toHaveLength(1); });
  expect(turn(chat).body).toEqual({ content: MESSAGE });
  expect(chat.writes).toEqual([]);
  // The composer stays empty: the words were the card's.
  expect(screen.getByLabelText(COMPOSER_LABEL).props.value).toBe('');
  await act(() => {
    turn(chat).emit('conversation', { id: 'c9', title: 'A party', userNodeId: 'u9', replyNodeId: 'a9', parentId: null });
    turn(chat).emit('text', { delta: 'Thanks.' });
    turn(chat).emit('done', { stopReason: 'end_turn', leafId: 'a9' });
    turn(chat).end();
  });
  await waitFor(() => {
    expect(chat.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/agent/questions/gap_2026-05-12_2026-05-13', body: { answer: 'other' } }]);
  });
  // Back on the new chat page, the row counts one fewer.
  await fireEvent.press(screen.getByRole('button', { name: 'New chat' }));
  expect(await screen.findByRole('button', { name: 'Questions and activity (8)' })).toBeTruthy();
  for (const name of ['setItemAsync', 'getItemAsync', 'deleteItemAsync'] as const) {
    for (const call of jest.mocked(SecureStore[name]).mock.calls) {
      expect(call[0]).toMatch(/^townwise\.chatReturn\./);
      expect(JSON.stringify(call)).not.toContain(WORDS);
    }
  }
});

// D71: a past private event's guests, on a phone's landing.
test('a private event’s question saves a count typed in its Guests field, and Save waits for a whole count', async () => {
  at(375);
  const path = `/api/org/locations/l1/agent/questions/${fixture.partyGuests.answer.questionId}`;
  const { chat } = await renderAgent('/locations/l1/agent', { ...fixture.panel, questions: fixture.partyGuests.questions });
  chat.respond[path] = () => fixture.partyGuests.answer.response;
  const landing = await screen.findByTestId('chat-landing');
  expect(await within(landing).findByRole('heading', { name: 'How many guests came for the private event on Sat, Apr 4, 2026?' })).toBeTruthy();
  const save = () => within(landing).getByRole('button', { name: 'Save' });
  expect(save().props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.changeText(within(landing).getByLabelText('Guests who came'), '20001');
  expect(save().props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.changeText(within(landing).getByLabelText('Guests who came'), '43');
  expect(save().props.accessibilityState).toMatchObject({ disabled: false });
  await fireEvent.press(save());
  expect(await within(landing).findByText('Saved: 43 guests on the private event note.')).toBeTruthy();
  expect(chat.writes).toEqual([{ method: 'POST', path, body: { answer: 'guests', guests: 43 } }]);
});
