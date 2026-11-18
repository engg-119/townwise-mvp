import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, refusal, SUMMARY, type FakeChatApi, type LiveTurn, forgetLastChats } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// TownwiseAI's questions on web (spec P25, 10.12; contract section 7): the evidence each one shows, the fourth answer
// Something else… (a field of the card's own whose words go to the chat as a message, then answer `other`), the
// questions inline under the landing's chips, and ?panel=questions (Home's link) opening the panel on load. The panel
// shows only on the new chat page (spec P25 build note, 2026-11-18), and beside the landing, which lists the
// questions, it leaves them out (owner request, 2026-11-15), so a card is drawn once, on the landing; a message from
// one opens a conversation, and its card's outcome shows when the person comes back to a new chat.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as { panel: { questions: unknown[]; activity: unknown[] } };

const GAP_ID = 'gap_2026-05-12_2026-05-13';
const GAP_HEADING = 'Were you closed May 12 to May 13, 2026?';
const LIKELY_HEADING = 'Were you open on Sat, May 23, 2026?';
const FIELD = 'Tell TownwiseAI in your own words';
const WORDS = 'A private party had the whole place. Sentinel-typed-words.';
const MESSAGE = `About May 12 to May 13, 2026 (no sales on these 2 days; those days of the week usually have about 100 guests): ${WORDS}`;
const SENT_LINE = 'Sent to TownwiseAI in the chat. It won’t ask about these days again.';
const BUDGET_USED = 'This month’s budget is used up, so TownwiseAI can’t answer in the chat.';

// The composer measures itself; jsdom has no ResizeObserver, and nothing here lays anything out.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void { /* nothing is laid out */ }
    unobserve(): void { /* nothing is laid out */ }
    disconnect(): void { /* nothing is laid out */ }
  };
}

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  // The conversation the page closed on (src/chat/lastChat.ts) is kept in localStorage: each test opens a new page.
  localStorage.clear();
  resetDrafts();
  forgetLastChats();
  resetProfiles();
  resetVersionFocus();
  setWidth(1280);
});

function chatApi(): FakeChatApi {
  const api = fakeChatApi();
  api.panel = fixture.panel;
  return api;
}

function renderAt(path: string, api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  if (!('about' in api)) serveAbout(api);
  const portal = fakePortalApi({ me, org: orgOf('member'), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: ['a', 'example.com'].join('@') } }, { api: portal });
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

function turn(api: FakeChatApi): LiveTurn {
  const live = api.turns.at(-1);
  if (live === undefined) throw new Error('no turn');
  return live;
}

/** Events and the turn settling (a few promise hops after end) inside one act. */
async function stream(steps: () => void): Promise<void> {
  await act(() => new Promise((resolve) => {
    steps();
    setTimeout(resolve, 50);
  }));
}

function saved(api: FakeChatApi): void {
  turn(api).emit('conversation', { id: 'c9', title: 'A private party', userNodeId: 'u9', replyNodeId: 'a9', parentId: null });
  turn(api).emit('text', { delta: 'Thanks. Want a note for those days?' });
  turn(api).emit('done', { stopReason: 'end_turn', leafId: 'a9' });
  turn(api).end();
}

/** The fixture's open weekly suggestions and (D46) suggested rules, which the header's button counts with the open questions. */
const OPEN_SUGGESTIONS = 4;

/** The panel's column, open by default beside the new chat page from 641px, once its button counts `questions`. */
async function openPanel(questions: number): Promise<HTMLElement> {
  await screen.findByRole('button', { name: `Questions and activity (${String(questions + OPEN_SUGGESTIONS)})` });
  return screen.findByTestId('agent-side');
}

/** A card's answers, found by its question. */
function answers(scope: HTMLElement, heading: string): HTMLElement {
  return within(scope).getByRole('group', { name: heading });
}

/** A whole card, found by its question: the heading's parent. */
function card(scope: HTMLElement, heading: string): HTMLElement {
  const found = within(scope).getByRole('heading', { level: 3, name: heading }).parentElement;
  if (found === null) throw new Error(`no card for ${heading}`);
  return found;
}

/**
 * The question cards: under the landing's chips (the panel's column leaves them out then), else, while TownwiseAI is
 * off, in the column. Read again at each step: a card's message leaves the landing, and a first turn refused outright
 * brings it back.
 */
function cards(): HTMLElement {
  return screen.queryByTestId('chat-landing-questions') ?? screen.getByTestId('agent-side');
}

/** Waits for `text` in the cards, wherever they are drawn at each try. */
function findInCards(text: string): Promise<HTMLElement> {
  return waitFor(() => within(cards()).getByText(text));
}

/** Back to the new chat page from a conversation (New chat), where the cards are; nothing when it already shows. */
async function toLanding(): Promise<void> {
  if (screen.queryByTestId('chat-landing') !== null) return;
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByTestId('chat-landing-questions');
}

/** Opens the gap's Something else… in `scope`, types the words and sends them. */
function tellGap(scope: HTMLElement): void {
  fireEvent.click(within(answers(scope, GAP_HEADING)).getByRole('button', { name: 'Something else…' }));
  fireEvent.change(within(scope).getByLabelText(FIELD), { target: { value: WORDS } });
  fireEvent.click(within(scope).getByRole('button', { name: 'Send to TownwiseAI' }));
}

/** The turn fails once part of the reply is in: the thread keeps both, with Try again under the reply. */
async function failMidStream(api: FakeChatApi): Promise<void> {
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  await stream(() => {
    turn(api).emit('text', { delta: 'Let me' });
    turn(api).emit('error', { code: 'provider_overloaded' });
    turn(api).end();
  });
}

function expectOff(control: HTMLElement, reason: string): void {
  expect(control.getAttribute('aria-disabled')).toBe('true');
  const ids = control.getAttribute('aria-describedby')?.split(' ') ?? [];
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(reason);
}

/** Every write and every turn the page sent, as text. */
function sent(api: FakeChatApi): { writes: string; turns: string } {
  return { writes: JSON.stringify(api.writes), turns: JSON.stringify(api.turns.map((live) => live.body)) };
}

describe('each card shows its evidence', () => {
  test('a likely-closed day and a gap, with four answers and what they do', async () => {
    renderAt('/locations/l1/agent', chatApi());
    await openPanel(2);
    expect(await findInCards('Only 1 guest was recorded. Saturdays usually have about 100.')).toBeTruthy();
    expect(within(cards()).getByRole('heading', { level: 3, name: LIKELY_HEADING })).toBeTruthy();
    expect(within(cards()).getByText('Only 1 guest was recorded. Saturdays usually have about 100.')).toBeTruthy();
    expect(within(answers(cards(), LIKELY_HEADING)).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Yes, it was just slow', 'No, we were closed', 'Not sure', 'Something else…',
    ]);
    expect(within(cards()).getByText('There are no sales for these 2 days. You usually have about 100 guests on those days of the week.')).toBeTruthy();
    expect(within(cards()).getByText('Yes saves a closure note for those days. If the data is missing, upload those days and TownwiseAI will use them. Something else lets you tell TownwiseAI in the chat.')).toBeTruthy();
  });

  test('“Yes, it was just slow” saves the open-day note, and the card says Townwise now counts that day', async () => {
    const api = chatApi();
    api.respond['/api/org/locations/l1/agent/questions/likely_closed_2026-05-23'] = () => ({
      question: { id: 'likely_closed_2026-05-23', answer: 'open' },
      note: {
        id: 'n3', kind: 'other', startDate: '2026-05-23', endDate: '2026-05-23', weekdays: null, effect: 'fewer_guests', expectedGuests: null,
        detail: 'Open, with very few guests (your answer to TownwiseAI).', startTime: null, endTime: null, createdByEmail: 'owner',
        createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', canEdit: true,
      },
    });
    renderAt('/locations/l1/agent', api);
    await openPanel(2);
    fireEvent.click(within(answers(cards(), LIKELY_HEADING)).getByRole('button', { name: 'Yes, it was just slow' }));
    expect(await findInCards('Saved a note: you were open on Sat, May 23, 2026, with fewer guests than usual. Townwise now counts that day.')).toBeTruthy();
    expect(api.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/agent/questions/likely_closed_2026-05-23', body: { answer: 'open' } }]);
  });
});

describe('Something else…', () => {
  test('opens a labeled field of the card’s own; Cancel closes it, drops the words and gives focus back', async () => {
    renderAt('/locations/l1/agent', chatApi());
    await openPanel(2);
    const other = within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' });
    expect(other.getAttribute('aria-expanded')).toBe('false');
    expect(within(cards()).queryByLabelText(FIELD)).toBeNull();
    fireEvent.click(other);
    expect(other.getAttribute('aria-expanded')).toBe('true');
    const field = within(cards()).getByLabelText(FIELD);
    expect(field.tagName).toBe('TEXTAREA');
    expect(document.activeElement).toBe(field);
    expect(within(cards()).getByText('Leave out guest names. TownwiseAI answers in the chat.')).toBeTruthy();
    // Not the composer: that stays empty.
    expect(screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL).value).toBe('');
    // Send waits for words.
    expect(within(cards()).getByRole('button', { name: 'Send to TownwiseAI' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(within(cards()).getByRole('button', { name: 'Send to TownwiseAI' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(field, { target: { value: WORDS } });
    expect(within(cards()).getByRole('button', { name: 'Send to TownwiseAI' }).getAttribute('aria-disabled')).toBeNull();
    // The field holds what fits in one chat message after the question's own words.
    expect(Number(field.getAttribute('maxlength'))).toBe(4000 - MESSAGE.length + WORDS.length);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Cancel' }));
    expect(within(cards()).queryByLabelText(FIELD)).toBeNull();
    expect(other.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(other);
    fireEvent.click(other);
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe('');
  });

  test('the field takes focus in its card, and pressing Something else… again folds the field and keeps the words', async () => {
    renderAt('/locations/l1/agent', chatApi());
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    const other = (): HTMLElement => within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Something else…' });
    fireEvent.click(other());
    expect(document.activeElement).toBe(within(landing).getByLabelText(FIELD));
    // Folded with Something else…, the field keeps its words; only Cancel drops them.
    fireEvent.change(within(landing).getByLabelText(FIELD), { target: { value: WORDS } });
    fireEvent.click(other());
    expect(within(landing).queryByLabelText(FIELD)).toBeNull();
    expect(other().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(other());
    expect(within(landing).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(document.activeElement).toBe(within(landing).getByLabelText(FIELD));
  });

  test('sends the question with the person’s words to the chat, then answers other once the turn is saved; the words go nowhere else', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    try {
      const api = chatApi();
      renderAt('/locations/l1/agent', api);
      const column = await openPanel(2);
      // Beside the empty conversation's landing, the column leaves the questions to the landing.
      expect(within(column).queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
      fireEvent.click(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' }));
      fireEvent.change(within(cards()).getByLabelText(FIELD), { target: { value: `  ${WORDS}\n` } });
      fireEvent.click(within(cards()).getByRole('button', { name: 'Send to TownwiseAI' }));
      // A message in the conversation shown (the landing starts one), exactly as the composer sends one.
      await waitFor(() => { expect(api.turns).toHaveLength(1); });
      expect(turn(api).body).toEqual({ content: MESSAGE });
      const log = await screen.findByRole('log', { name: 'Conversation with TownwiseAI' });
      expect(within(log).getByText(MESSAGE)).toBeTruthy();
      // The conversation is open, so the landing, its cards and the panel's column have gone (only on the new chat page).
      expect(screen.queryByTestId('chat-landing-questions')).toBeNull();
      expect(column.isConnected).toBe(false);
      expect(screen.queryByRole('button', { name: /^Questions and activity/ })).toBeNull();
      // Nothing is answered until the turn is saved, and focus goes to the composer, as after a chip.
      expect(api.writes).toEqual([]);
      expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL));
      await stream(() => { saved(api); });
      await waitFor(() => {
        expect(api.writes).toEqual([{ method: 'POST', path: `/api/org/locations/l1/agent/questions/${GAP_ID}`, body: { answer: 'other' } }]);
      });
      // Back on the new chat page, the card says what happened, and the count follows.
      await toLanding();
      expect(await findInCards(SENT_LINE)).toBeTruthy();
      expect(within(cards()).queryByLabelText(FIELD)).toBeNull();
      expect(screen.getByRole('button', { name: 'Questions and activity (5)' })).toBeTruthy();
      // The words went once, in the turn; no write carries them, and nothing went to browser storage.
      const { writes, turns } = sent(api);
      expect(writes).not.toContain('Sentinel-typed-words');
      expect(turns.split('Sentinel-typed-words')).toHaveLength(2);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  test.each([
    ['refused before it starts', (api: FakeChatApi) => { api.refuse = refusal(429, 'rate_limited'); }, null, 'You’ve sent a lot of messages. Try again later.'],
    ['refused by the model', null, (api: FakeChatApi) => {
      turn(api).emit('conversation', { id: 'c9', title: 'A party', userNodeId: null, replyNodeId: null, parentId: null });
      turn(api).emit('done', { stopReason: 'refusal', leafId: null });
      turn(api).end();
    }, 'TownwiseAI can’t help with that. Your message and this reply weren’t saved.'],
    ['failed while streaming', null, (api: FakeChatApi) => {
      turn(api).emit('text', { delta: 'Let me' });
      turn(api).emit('error', { code: 'provider_overloaded' });
      turn(api).end();
    }, 'TownwiseAI is busy. Try again in a minute.'],
    ['cut off', null, (api: FakeChatApi) => {
      turn(api).emit('text', { delta: 'Let me' });
      turn(api).end();
    }, 'The reply was cut off. Try again.'],
  ])('a turn %s answers nothing; the card keeps the words and says why', async (_name, before, during, words) => {
    const api = chatApi();
    before?.(api);
    renderAt('/locations/l1/agent', api);
    await openPanel(2);
    fireEvent.click(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' }));
    fireEvent.change(within(cards()).getByLabelText(FIELD), { target: { value: WORDS } });
    fireEvent.click(within(cards()).getByRole('button', { name: 'Send to TownwiseAI' }));
    if (during !== null) {
      await waitFor(() => { expect(api.turns).toHaveLength(1); });
      await stream(() => { during(api); });
    } else {
      // Refused before it starts, the turn is taken back and the landing returns by itself.
      await screen.findByTestId('chat-landing-questions');
    }
    // The words stay in the card, never put in the composer.
    expect(screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL).value).toBe('');
    await toLanding();
    expect(await findInCards(words)).toBeTruthy();
    expect(api.writes).toEqual([]);
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    // The words stay in the card, never put in the composer.
    expect(screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL).value).toBe('');
    expect(screen.getByRole('button', { name: 'Questions and activity (6)' })).toBeTruthy();
  });

  test('a saved turn whose answer doesn’t save says so, and Try again answers without sending the words again', async () => {
    const api = chatApi();
    let fail = true;
    api.respond[`/api/org/locations/l1/agent/questions/${GAP_ID}`] = () => (fail
      ? refusal(429, 'rate_limited')
      : { question: { id: GAP_ID, answer: 'other' }, note: null });
    renderAt('/locations/l1/agent', api);
    await openPanel(2);
    fireEvent.click(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' }));
    fireEvent.change(within(cards()).getByLabelText(FIELD), { target: { value: WORDS } });
    fireEvent.click(within(cards()).getByRole('button', { name: 'Send to TownwiseAI' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => { saved(api); });
    await toLanding();
    expect(await findInCards('You’ve made a lot of changes. Try again later.')).toBeTruthy();
    expect(within(cards()).getByText('Your message is in the chat.')).toBeTruthy();
    fail = false;
    fireEvent.click(within(cards()).getByRole('button', { name: 'Try again' }));
    expect(await findInCards(SENT_LINE)).toBeTruthy();
    expect(api.turns).toHaveLength(1);
    expect(api.writes.map((write) => write.body)).toEqual([{ answer: 'other' }, { answer: 'other' }]);
  });

  test('Try again under its failed reply in the thread, refused, leaves the words in the card and never in the composer', async () => {
    const api = chatApi();
    renderAt('/locations/l1/agent?panel=questions', api);
    await screen.findByTestId('agent-side');
    tellGap(cards());
    await failMidStream(api);
    api.refuse = refusal(429, 'rate_limited');
    const log = screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
    fireEvent.click(within(log).getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByText('You’ve sent a lot of messages. Try again later.')).not.toHaveLength(0);
    expect(screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL).value).toBe('');
    await toLanding();
    expect(await findInCards('You’ve sent a lot of messages. Try again later.')).toBeTruthy();
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(api.writes).toEqual([]);
  });

  test('Try again under its failed reply in the thread, saved, answers other once, as the card’s own Send would', async () => {
    const api = chatApi();
    renderAt('/locations/l1/agent?panel=questions', api);
    await screen.findByTestId('agent-side');
    tellGap(cards());
    await failMidStream(api);
    fireEvent.click(within(screen.getByRole('log', { name: 'Conversation with TownwiseAI' })).getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(api.turns).toHaveLength(2); });
    expect(turn(api).body).toEqual({ content: MESSAGE });
    await stream(() => { saved(api); });
    await waitFor(() => {
      expect(api.writes).toEqual([{ method: 'POST', path: `/api/org/locations/l1/agent/questions/${GAP_ID}`, body: { answer: 'other' } }]);
    });
    await toLanding();
    expect(await findInCards(SENT_LINE)).toBeTruthy();
    expect(within(cards()).queryByText('TownwiseAI is busy. Try again in a minute.')).toBeNull();
    expect(within(cards()).queryByRole('button', { name: 'Send to TownwiseAI' })).toBeNull();
  });

  test('a message turned away because the month’s budget is used up says so once on its card', async () => {
    const api = chatApi();
    api.refuse = refusal(409, 'chat_budget_exhausted');
    renderAt('/locations/l1/agent?panel=questions', api);
    await screen.findByTestId('agent-side');
    await screen.findByLabelText(COMPOSER_LABEL);
    // Used up since the page read it: the chat reads it again after the turn.
    api.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 20, exhausted: true } };
    tellGap(cards());
    expect(await waitFor(() => within(card(cards(), GAP_HEADING)).getByText(BUDGET_USED))).toBeTruthy();
    expect(within(card(cards(), GAP_HEADING)).getAllByText(BUDGET_USED)).toHaveLength(1);
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(api.writes).toEqual([]);
  });

  test('a card announces its error as an alert and its answer as a status', async () => {
    const api = chatApi();
    let fail = true;
    api.respond[`/api/org/locations/l1/agent/questions/${GAP_ID}`] = () => (fail
      ? refusal(429, 'rate_limited')
      : { question: { id: GAP_ID, answer: 'not_sure' }, note: null });
    renderAt('/locations/l1/agent?panel=questions', api);
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    fireEvent.click(within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Not sure' }));
    const error = 'You’ve made a lot of changes. Try again later.';
    expect((await within(landing).findByText(error)).getAttribute('role')).toBe('alert');
    fail = false;
    fireEvent.click(within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Not sure' }));
    const line = 'Got it. TownwiseAI won’t ask about these days again.';
    expect((await within(landing).findByText(line)).getAttribute('role')).toBe('status');
    // Drawn once: the column beside the landing leaves the questions out.
    expect(within(screen.getByTestId('agent-side')).queryByText(line)).toBeNull();
  });

  test('is disabled with its reason under view-as, while a reply streams and once the month’s budget is used up', async () => {
    renderAt('/locations/l1/agent', chatApi(), viewAsMe(ACCESS.member));
    await openPanel(2);
    const viewed = within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' });
    expect(viewed.getAttribute('aria-disabled')).toBe('true');
    expect(viewed.getAttribute('aria-describedby')?.split(' ')).toContain('chat-ro');
    fireEvent.click(viewed);
    expect(within(cards()).queryByLabelText(FIELD)).toBeNull();
    cleanup();

    const spent = chatApi();
    spent.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 20, exhausted: true } };
    renderAt('/locations/l1/agent', spent);
    await openPanel(2);
    expectOff(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' }), BUDGET_USED);
    // The other answers don't need the chat.
    expect(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Not sure' }).getAttribute('aria-disabled')).toBeNull();
    // While a reply streams a conversation is open, so the cards (only on the new chat page) aren't drawn.
  });

  test('is not offered while TownwiseAI’s chat is off', async () => {
    const api = chatApi();
    api.summary = { ...SUMMARY, enabled: false };
    renderAt('/locations/l1/agent', api);
    await openPanel(2);
    expect(await within(cards()).findAllByRole('button', { name: 'No, the data is missing' })).toHaveLength(1);
    expect(within(cards()).queryByRole('button', { name: 'Something else…' })).toBeNull();
    expect(within(cards()).queryByText(/Something else lets you/)).toBeNull();
  });
});

describe('at 640px and below', () => {
  test('the panel is a row under the chips that opens in place, without the questions the landing lists; a card’s message opens the conversation and its outcome shows back on the new chat page', async () => {
    setWidth(390);
    const api = chatApi();
    renderAt('/locations/l1/agent', api);
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    const row = await within(landing).findByRole('button', { name: 'Questions and activity (6)' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    const side = within(screen.getByTestId('chat-panel-row')).getByTestId('agent-side');
    expect(within(side).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    expect(within(side).queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
    tellGap(landing);
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('error', { code: 'provider_unavailable' });
      turn(api).end();
    });
    expect(screen.queryByTestId('chat-panel-row')).toBeNull();
    await toLanding();
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(within(cards()).getByText('Can’t reach TownwiseAI. Try again.')).toBeTruthy();
    expect(api.writes).toEqual([]);
  });
});

describe('inline on the landing', () => {
  test('under the composer and the chips, Questions for you (N) shows the cards, once from 1024px, and an answer in one place shows in the other', async () => {
    const api = chatApi();
    renderAt('/locations/l1/agent', api);
    const landing = await screen.findByTestId('chat-landing-column');
    const heading = await within(landing).findByRole('heading', { level: 2, name: 'Questions for you (2)' });
    const chips = within(landing).getByRole('group', { name: 'Suggestions' });
    expect(chips.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(landing).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      LIKELY_HEADING, GAP_HEADING,
    ]);
    // Answered here, it shows what the answer did, and the counts follow.
    fireEvent.click(within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Not sure' }));
    expect(await within(landing).findByText('Got it. TownwiseAI won’t ask about these days again.')).toBeTruthy();
    expect(within(landing).getByRole('heading', { level: 2, name: 'Questions for you (1)' })).toBeTruthy();
    // The column beside the landing leaves the questions out: they're drawn once, here.
    const column = await openPanel(1);
    expect(within(column).queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
    // The suggested rules (D46), which the landing doesn't list, come first in the column.
    expect(within(column).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    fireEvent.click(within(answers(landing, LIKELY_HEADING)).getByRole('button', { name: 'Not sure' }));
    expect(await within(landing).findByText('Got it. TownwiseAI won’t ask about this day again.')).toBeTruthy();
    expect(within(landing).getByRole('heading', { level: 2, name: 'Questions for you' })).toBeTruthy();
    expect(api.writes).toHaveLength(2);
    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('Something else… from the landing starts the conversation with the message, and focus goes to the composer', async () => {
    const api = chatApi();
    renderAt('/locations/l1/agent', api);
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    fireEvent.click(within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Something else…' }));
    fireEvent.change(within(landing).getByLabelText(FIELD), { target: { value: WORDS } });
    fireEvent.click(within(landing).getByRole('button', { name: 'Send to TownwiseAI' }));
    const log = await screen.findByRole('log', { name: 'Conversation with TownwiseAI' });
    expect(within(log).getByText(MESSAGE)).toBeTruthy();
    expect(turn(api).body).toEqual({ content: MESSAGE });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL)); });
    await stream(() => { saved(api); });
    await waitFor(() => { expect(api.writes.map((write) => write.body)).toEqual([{ answer: 'other' }]); });
    await toLanding();
    expect(screen.getByRole('button', { name: 'Questions and activity (5)' })).toBeTruthy();
  });

  test('none when there are none, or when the questions can’t be read; under view-as they are read-only', async () => {
    const api = chatApi();
    api.panel = { questions: [], activity: [] };
    renderAt('/locations/l1/agent', api);
    const empty = await screen.findByTestId('chat-landing-column');
    await within(empty).findByRole('group', { name: 'Suggestions' });
    await waitFor(() => { expect(api.panelLoads).toBe(1); });
    expect(within(empty).queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
    cleanup();

    const failing = chatApi();
    failing.panelError = refusal(503, 'unavailable');
    renderAt('/locations/l1/agent', failing);
    const unread = await screen.findByTestId('chat-landing-column');
    await within(unread).findByRole('group', { name: 'Suggestions' });
    await waitFor(() => { expect(failing.panelLoads).toBe(1); });
    expect(within(unread).queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
    cleanup();

    renderAt('/locations/l1/agent', chatApi(), viewAsMe(ACCESS.member));
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    const notSure = within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Not sure' });
    expect(notSure.getAttribute('aria-disabled')).toBe('true');
    expect(notSure.getAttribute('aria-describedby')?.split(' ')).toContain('chat-ro');
  });
});

describe('?panel=questions (Home’s link)', () => {
  test('opens the panel as a column from 1024px and drops the parameter; beside the landing the questions are under its chips', async () => {
    renderAt('/locations/l1/agent?panel=questions', chatApi());
    const side = await screen.findByTestId('agent-side');
    expect(screen.getByRole('button', { name: 'Questions and activity (6)' }).getAttribute('aria-expanded')).toBe('true');
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    expect(within(side).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    await waitFor(() => { expect(window.location.search).toBe(''); });
    expect(window.location.pathname).toBe('/locations/l1/agent');
    // Closed by the person, it stays closed.
    fireEvent.click(screen.getByRole('button', { name: 'Questions and activity (6)' }));
    expect(screen.queryByTestId('agent-side')).toBeNull();
  });

  // An independent browser review, 2026-11-18: at 390px Home's link opened the row with Suggested rules, the
  // suggestions, the activity and the budget above the questions, which sat about 1350px down, off screen.
  test('at 640px and below opens the row under the chips with Questions for you first, then Suggested rules (D46), and drops the parameter', async () => {
    setWidth(390);
    renderAt('/locations/l1/agent?panel=questions', chatApi());
    const row = await screen.findByRole('button', { name: 'Questions and activity (6)' });
    await waitFor(() => { expect(row.getAttribute('aria-expanded')).toBe('true'); });
    const wrap = screen.getByTestId('chat-panel-row');
    await within(wrap).findByRole('heading', { name: 'Questions for you (2)' });
    const region = within(wrap).getByTestId('agent-side');
    expect(region.id).toBe(row.getAttribute('aria-controls'));
    // The questions first in the opened row, drawn once, then the panel's sections from Suggested rules.
    expect(within(region).getAllByRole('heading')[0]?.textContent).toBe('Questions for you (2)');
    expect(region.firstElementChild).toBe(screen.getByTestId('chat-landing-questions'));
    expect(screen.getAllByRole('heading', { name: /^Questions for you/ })).toHaveLength(1);
    const sections = region.lastElementChild;
    if (!(sections instanceof HTMLElement)) throw new Error('no panel sections');
    expect(within(sections).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    await waitFor(() => { expect(window.location.search).toBe(''); });
    // Once the person closes the row, the questions are back under it, and opening it again is a normal open.
    fireEvent.click(row);
    expect(screen.queryByTestId('agent-side')).toBeNull();
    expect(wrap.nextElementSibling).toBe(screen.getByTestId('chat-landing-questions'));
    fireEvent.click(row);
    expect(within(within(wrap).getByTestId('agent-side')).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    expect(wrap.nextElementSibling).toBe(screen.getByTestId('chat-landing-questions'));
  });
});
