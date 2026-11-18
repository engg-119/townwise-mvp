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
import { fakeChatApi, refusal, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// TownwiseAI's questions on web (spec P25, 10.12; contract section 7): the evidence each one shows, the fourth answer
// Something else… (a field of the card's own whose words go to the chat as a message, then answer `other`), the
// questions inline under the landing's chips sharing their answers with the panel, and ?panel=questions (Home's
// link) opening the panel on load. Beside an empty conversation's landing, which lists the questions, the panel's
// column leaves them out (owner request, 2026-11-15); the sheet below 1024px keeps them.

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
  resetDrafts();
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

/**
 * The fixture's open weekly suggestions (a rule, a note, a spotted event, a move and a removal) and (D46) suggested
 * rules, which the header's button counts with the open questions.
 */
const OPEN_SUGGESTIONS = 7;

async function openPanel(questions: number): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Questions and activity (${String(questions + OPEN_SUGGESTIONS)})` }));
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
 * The question cards from 1024px: under the landing's chips while the conversation is empty (the panel's column leaves
 * them out then), else in the column. Read again at each step: a card's message leaves the landing, and a first turn
 * refused outright brings it back.
 */
function cards(): HTMLElement {
  return screen.queryByTestId('chat-landing-questions') ?? screen.getByTestId('agent-side');
}

/** Waits for `text` in the cards, wherever they are drawn at each try. */
function findInCards(text: string): Promise<HTMLElement> {
  return waitFor(() => within(cards()).getByText(text));
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

  // The sheet is a Modal; opening it, twice in the first, can pass 5 seconds on a loaded runner.
  test('the field takes focus in the card whose Something else… was pressed, and pressing it again folds the field and keeps the words', async () => {
    // Below 1024px the sheet keeps the questions over the landing, so the card is drawn in both places.
    setWidth(800);
    renderAt('/locations/l1/agent?panel=questions', chatApi());
    let sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    await waitFor(() => { expect(document.activeElement).toBe(within(sheet).getByRole('heading', { name: 'Questions and activity' })); });
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    const otherIn = (scope: HTMLElement): HTMLElement => within(answers(scope, GAP_HEADING)).getByRole('button', { name: 'Something else…' });
    fireEvent.click(otherIn(sheet));
    expect(document.activeElement).toBe(within(sheet).getByLabelText(FIELD));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    const button = screen.getByRole('button', { name: 'Questions and activity (9)' });
    await waitFor(() => { expect(document.activeElement).toBe(button); });
    // Opened from the landing next, the landing's field takes focus, not the sheet's.
    fireEvent.click(otherIn(landing));
    expect(document.activeElement).toBe(within(landing).getByLabelText(FIELD));
    // Folded with Something else…, the field keeps its words, in both places; only Cancel drops them.
    fireEvent.change(within(landing).getByLabelText(FIELD), { target: { value: WORDS } });
    fireEvent.click(otherIn(landing));
    expect(within(landing).queryByLabelText(FIELD)).toBeNull();
    expect(otherIn(landing).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    await waitFor(() => { expect(document.activeElement).toBe(within(sheet).getByRole('heading', { name: 'Questions and activity' })); });
    fireEvent.click(otherIn(sheet));
    expect(within(sheet).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(document.activeElement).toBe(within(sheet).getByLabelText(FIELD));
  }, 15_000);

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
      // The landing has gone, so the column lists the questions again, the card with them.
      expect(screen.queryByTestId('chat-landing-questions')).toBeNull();
      expect(within(column).getByRole('heading', { name: 'Questions for you' })).toBeTruthy();
      // Nothing is answered until the turn is saved; meanwhile no other answer can go.
      expect(api.writes).toEqual([]);
      expect(within(cards()).getByText('Sending to TownwiseAI…')).toBeTruthy();
      expect(within(answers(cards(), LIKELY_HEADING)).getByRole('button', { name: 'Not sure' }).getAttribute('aria-disabled')).toBe('true');
      // From 1024px the column stays open, and focus goes to the composer, as after a chip.
      expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL));
      await stream(() => { saved(api); });
      await waitFor(() => {
        expect(api.writes).toEqual([{ method: 'POST', path: `/api/org/locations/l1/agent/questions/${GAP_ID}`, body: { answer: 'other' } }]);
      });
      expect(await findInCards(SENT_LINE)).toBeTruthy();
      expect(within(cards()).queryByLabelText(FIELD)).toBeNull();
      expect(screen.getByRole('button', { name: 'Questions and activity (8)' })).toBeTruthy();
      expect(screen.getByTestId('agent-side')).toBe(column);
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
    }
    expect(await findInCards(words)).toBeTruthy();
    expect(api.writes).toEqual([]);
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    // The words stay in the card, never put in the composer.
    expect(screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL).value).toBe('');
    expect(screen.getByRole('button', { name: 'Questions and activity (9)' })).toBeTruthy();
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
    expect(await findInCards('TownwiseAI is busy. Try again in a minute.')).toBeTruthy();
    api.refuse = refusal(429, 'rate_limited');
    const log = screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
    fireEvent.click(within(log).getByRole('button', { name: 'Try again' }));
    expect(await findInCards('You’ve sent a lot of messages. Try again later.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL).value).toBe('');
    expect(within(cards()).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(api.writes).toEqual([]);
  });

  test('Try again under its failed reply in the thread, saved, answers other once, as the card’s own Send would', async () => {
    const api = chatApi();
    renderAt('/locations/l1/agent?panel=questions', api);
    await screen.findByTestId('agent-side');
    tellGap(cards());
    await failMidStream(api);
    expect(await findInCards('TownwiseAI is busy. Try again in a minute.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('log', { name: 'Conversation with TownwiseAI' })).getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(api.turns).toHaveLength(2); });
    expect(turn(api).body).toEqual({ content: MESSAGE });
    await stream(() => { saved(api); });
    await waitFor(() => {
      expect(api.writes).toEqual([{ method: 'POST', path: `/api/org/locations/l1/agent/questions/${GAP_ID}`, body: { answer: 'other' } }]);
    });
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

  // The sheet is a Modal; opening it, twice in the first, can pass 5 seconds on a loaded runner.
  test('a card in both places announces its error and its answer only from the one the person used', async () => {
    const api = chatApi();
    let fail = true;
    api.respond[`/api/org/locations/l1/agent/questions/${GAP_ID}`] = () => (fail
      ? refusal(429, 'rate_limited')
      : { question: { id: GAP_ID, answer: 'not_sure' }, note: null });
    // Below 1024px the sheet keeps the questions over the landing, so the card is drawn in both places.
    setWidth(800);
    renderAt('/locations/l1/agent?panel=questions', api);
    const side = await screen.findByTestId('agent-side');
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    fireEvent.click(within(answers(landing, GAP_HEADING)).getByRole('button', { name: 'Not sure' }));
    const error = 'You’ve made a lot of changes. Try again later.';
    expect(await within(landing).findByText(error)).toBeTruthy();
    // Both show it; only the landing's is an alert.
    expect(within(landing).getByText(error).getAttribute('role')).toBe('alert');
    expect(within(side).getByText(error).getAttribute('role')).toBeNull();
    fail = false;
    fireEvent.click(within(answers(side, GAP_HEADING)).getByRole('button', { name: 'Not sure' }));
    const line = 'Got it. TownwiseAI won’t ask about these days again.';
    expect(await within(side).findByText(line)).toBeTruthy();
    expect(within(side).getByText(line).getAttribute('role')).toBe('status');
    expect(within(landing).getByText(line).getAttribute('role')).toBeNull();
  }, 15_000);

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
    cleanup();

    const api = chatApi();
    renderAt('/locations/l1/agent', api);
    fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'How was May?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await openPanel(2);
    expect(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' }).getAttribute('aria-disabled')).toBe('true');
    await stream(() => { saved(api); });
    expect(within(answers(cards(), GAP_HEADING)).getByRole('button', { name: 'Something else…' }).getAttribute('aria-disabled')).toBeNull();
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

describe('below 1024px', () => {
  test('a message from the sheet closes it once the turn starts, so the thread shows the message, and focus goes to the composer', async () => {
    setWidth(800);
    const api = chatApi();
    renderAt('/locations/l1/agent', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Questions and activity (9)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    tellGap(sheet);
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    // Not before: a turn refused outright would take the card's words and reason out of view.
    expect(screen.getByRole('dialog', { name: 'Questions and activity' })).toBe(sheet);
    await stream(() => {
      turn(api).emit('conversation', { id: 'c9', title: 'A private party', userNodeId: 'u9', replyNodeId: 'a9', parentId: null });
    });
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Questions and activity' })).toBeNull(); });
    const log = screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
    expect(within(log).getByText(MESSAGE)).toBeTruthy();
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL)); });
    await stream(() => {
      turn(api).emit('text', { delta: 'Thanks. Want a note for those days?' });
      turn(api).emit('done', { stopReason: 'end_turn', leafId: 'a9' });
      turn(api).end();
    });
    await waitFor(() => { expect(api.writes.map((write) => write.body)).toEqual([{ answer: 'other' }]); });
    fireEvent.click(screen.getByRole('button', { name: 'Questions and activity (8)' }));
    expect(await within(await screen.findByRole('dialog', { name: 'Questions and activity' })).findByText(SENT_LINE)).toBeTruthy();
  });

  test('a message that isn’t saved leaves its words and the reason in the card when the sheet opens again', async () => {
    setWidth(800);
    const api = chatApi();
    renderAt('/locations/l1/agent', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Questions and activity (9)' }));
    let sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    fireEvent.click(within(answers(sheet, GAP_HEADING)).getByRole('button', { name: 'Something else…' }));
    fireEvent.change(within(sheet).getByLabelText(FIELD), { target: { value: WORDS } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send to TownwiseAI' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('error', { code: 'provider_unavailable' });
      turn(api).end();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Questions and activity (9)' }));
    sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    expect(within(sheet).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
    expect(within(sheet).getByText('Can’t reach TownwiseAI. Try again.')).toBeTruthy();
    expect(api.writes).toEqual([]);
  });

  test('a message refused before its turn starts leaves the sheet open, with the words and the reason in the card', async () => {
    setWidth(800);
    const api = chatApi();
    api.refuse = refusal(429, 'rate_limited');
    renderAt('/locations/l1/agent', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Questions and activity (9)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    tellGap(sheet);
    expect(await within(sheet).findByText('You’ve sent a lot of messages. Try again later.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Questions and activity' })).toBe(sheet);
    expect(within(sheet).getByLabelText<HTMLTextAreaElement>(FIELD).value).toBe(WORDS);
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
    // From 1024px the column beside the landing leaves the questions out: they're drawn once, here.
    const column = await openPanel(1);
    expect(within(column).queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
    // The suggested rules (D46), which the landing doesn't list, come first in the column; then the weekly suggestions,
    // after what changed on the location's calendars.
    expect(within(column).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    expect(within(column).getByRole('heading', { name: 'Your calendar changed' })).toBeTruthy();
    // Below 1024px the panel is a sheet over the landing and keeps them, with the same answers and counts.
    setWidth(800);
    const side = await screen.findByRole('dialog', { name: 'Questions and activity' });
    expect(within(side).getByText('Got it. TownwiseAI won’t ask about these days again.')).toBeTruthy();
    expect(within(side).getByText('1 open')).toBeTruthy();
    // Answered in the sheet, it shows on the landing too.
    fireEvent.click(within(answers(side, LIKELY_HEADING)).getByRole('button', { name: 'Not sure' }));
    expect(await within(landing).findByText('Got it. TownwiseAI won’t ask about this day again.')).toBeTruthy();
    expect(within(landing).getByRole('heading', { level: 2, name: 'Questions for you' })).toBeTruthy();
    expect(api.writes).toHaveLength(2);
    // No element id is used twice with the card in both places.
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
    expect(screen.getByRole('button', { name: 'Questions and activity (8)' })).toBeTruthy();
  });

  test('none when there are none, or when the questions can’t be read; under view-as they are read-only', async () => {
    const api = chatApi();
    api.panel = { questions: [], activity: [] };
    renderAt('/locations/l1/agent', api);
    await screen.findByRole('group', { name: 'Suggestions' });
    await waitFor(() => { expect(api.panelLoads).toBe(1); });
    expect(screen.queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
    cleanup();

    const failing = chatApi();
    failing.panelError = refusal(503, 'unavailable');
    renderAt('/locations/l1/agent', failing);
    await screen.findByRole('group', { name: 'Suggestions' });
    await waitFor(() => { expect(failing.panelLoads).toBe(1); });
    expect(screen.queryByRole('heading', { name: /^Questions for you/ })).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Questions and activity (9)' }).getAttribute('aria-expanded')).toBe('true');
    const landing = await screen.findByTestId('chat-landing-column');
    await within(landing).findByRole('heading', { name: 'Questions for you (2)' });
    expect(within(side).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    expect(within(side).getByRole('heading', { name: 'Your calendar changed' })).toBeTruthy();
    await waitFor(() => { expect(window.location.search).toBe(''); });
    expect(window.location.pathname).toBe('/locations/l1/agent');
    // Closed by the person, it stays closed.
    fireEvent.click(screen.getByRole('button', { name: 'Questions and activity (9)' }));
    expect(screen.queryByTestId('agent-side')).toBeNull();
  });

  test('opens the sheet below 1024px, its heading focused and Suggested rules (D46) then Questions for you first', async () => {
    setWidth(800);
    renderAt('/locations/l1/agent?panel=questions', chatApi());
    const sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
    await waitFor(() => { expect(document.activeElement).toBe(within(sheet).getByRole('heading', { name: 'Questions and activity' })); });
    expect(within(within(sheet).getByTestId('agent-side')).getAllByRole('heading')[0]?.textContent).toBe('Suggested rules');
    await waitFor(() => { expect(window.location.search).toBe(''); });
  });
});
