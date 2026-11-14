import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { aboutDraft } from '../../src/chat/about';
import { resetDrafts } from '../../src/chat/drafts';
import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { localToday } from '../../src/portal/locations/dates';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import {
  CONVERSATION, fakeChatApi, PROPOSAL, PROPOSAL_ID, refusal as chatRefusal, SALES_STEP, SUMMARY, type FakeChatApi, type LiveTurn,
} from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { itemOf } from '../portal/data/fakes';
import { PUBLISHED, RUN, serveAbout } from './about-fakes';
import { daily } from './visuals-fixtures';

// P25 TownwiseAI on web (spec 16.3, D26): the greeting, the centered landing and the composer that docks under the
// thread, the keyboard (Enter sends, Shift+Enter and an input method's Enter don't), History's Escape, the panel as a
// column or a sheet, the next questions, the budget line, the live line and caret, reduced motion, the polite live
// region, the one primary, phone width, links that open in a new tab, and view-as's aria-disabled controls with the
// one read-only line.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  // Drafts and the name outlive the page in memory, as they do between visits in one session.
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
  Reflect.deleteProperty(window, 'matchMedia');
  setWidth(1280);
});

const EMAIL = ['a', 'example.com'].join('@');
/** The `white` (`cta`) fill of the page's one primary. */
const WHITE = 'rgb(239, 242, 246)';
const BUDGET_LINE = 'Most of November’s budget is used. TownwiseAI pauses when it runs out.';

/** CONVERSATION with a second version of its reply: GET shows the first, and the second is read by its node. */
const TWO_REPLIES = { ...CONVERSATION, tree: [...CONVERSATION.tree, { id: 'a2', parentId: 'u1', role: 'assistant' }] };
const SECOND_REPLY = {
  ...TWO_REPLIES,
  activeLeafId: 'a2',
  messages: [
    CONVERSATION.messages[0],
    {
      nodeId: 'a2', role: 'assistant', text: 'A second answer.', proposals: [], parts: [{ type: 'text', text: 'A second answer.' }],
      at: '2026-11-02T15:01:00.000Z',
    },
  ],
};

function renderAt(path: string, api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  // F10: GET .../estimates/about, with no forecast unless the test served another answer.
  if (!('about' in api)) serveAbout(api);
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

function reduceMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: query === '(prefers-reduced-motion: reduce)' && reduce,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

function style(element: Element): CSSStyleDeclaration {
  return window.getComputedStyle(element);
}

function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('none found');
  return item;
}

/** The page's own polite region (a copied reply has its own, beside its Copy button). */
function liveRegion(): HTMLElement {
  return screen.getByTestId('chat-live');
}

async function send(api: FakeChatApi, text: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => { expect(api.turns.length).toBeGreaterThan(0); });
}

async function openEarlierChat(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
  await screen.findByText('We close for the holidays.');
}

async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Questions and activity (2)' }));
  return screen.findByTestId('agent-side');
}

/**
 * A whole Escape press where focus is: react-native-web's Modal closes the top-most modal on its keyup. The page
 * renders between keydown and keyup, as in a browser, so a keydown that closed one modal can't hide a keyup that
 * then closes the next.
 */
function pressEscape(): void {
  act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
  act(() => { fireEvent.keyUp(document.activeElement ?? document.body, { key: 'Escape' }); });
}

function expectReadOnly(control: HTMLElement): void {
  expect(control.getAttribute('aria-disabled')).toBe('true');
  expect(control.getAttribute('aria-describedby')?.split(' ')).toContain('chat-ro');
}

test('the dashboard links to a location, whose TownwiseAI page greets the person, streams a reply with a card, and saves its note', async () => {
  const api = fakeChatApi();
  api.profile = { displayName: 'Cam', askName: false };
  renderAt('/dashboard', api);
  fireEvent.click(await screen.findByText('Main Street Bar'));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1'); });
  fireEvent.click(await screen.findByRole('link', { name: 'TownwiseAI' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/agent'); });
  expect(await screen.findByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  await waitFor(() => {
    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Welcome back, Cam.']);
  });

  await send(api, 'Closed for the holidays');
  expect(screen.getByRole('log', { name: 'Conversation with TownwiseAI' })).toBeTruthy();
  await stream(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'Closed for the holidays' });
    turn(api).emit('text', { delta: 'Here is a note.' });
    turn(api).emit('proposal', { id: PROPOSAL_ID, proposal: PROPOSAL });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  expect(screen.getByText('Here is a note.')).toBeTruthy();
  expect(screen.getByText('December 24, 2026 to December 26, 2026')).toBeTruthy();
  expect(screen.getByText('Based on this conversation only.')).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Save note' });
  fireEvent.click(save);
  const saved = await screen.findByText('Saved to Notes.');
  // The pressed button is gone: focus moves to the line that says what happened.
  await waitFor(() => { expect(document.activeElement?.contains(saved)).toBe(true); });
  expect(screen.getByRole('link', { name: 'Open Notes' }).getAttribute('href')).toBe('/locations/l1/notes');
});

test('the old chat address opens TownwiseAI, so links and bookmarks keep working', async () => {
  renderAt('/locations/l1/chat', fakeChatApi());
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/agent'); });
  expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back.' })).toBeTruthy();
  expect(await screen.findByLabelText(COMPOSER_LABEL)).toBeTruthy();
});

test('asks for a name once, above the chat, and the greeting takes it', async () => {
  const api = fakeChatApi();
  api.profile = { displayName: null, askName: true };
  renderAt('/locations/l1/agent', api);
  const ask = await screen.findByRole('heading', { level: 2, name: 'What should TownwiseAI call you?' });
  expect(before(ask, screen.getByRole('button', { name: 'History' }))).toBe(true);
  expect(screen.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'First name' }), { target: { value: 'Cam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back, Cam.' })).toBeTruthy();
  expect(screen.queryByText('What should TownwiseAI call you?')).toBeNull();
  expect(api.writes).toEqual([{ method: 'PATCH', path: '/api/me/profile', body: { displayName: 'Cam' } }]);
});

test('an empty conversation is the centered landing: heading, reads line, composer, then chips', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  const heading = await screen.findByRole('heading', { level: 2, name: 'Ask TownwiseAI about Main Street Bar' });
  const reads = screen.getByText('It reads your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data, and shows you each thing it reads. It suggests notes; you decide what’s saved.');
  const input = screen.getByLabelText(COMPOSER_LABEL);
  const chips = screen.getByRole('group', { name: 'Suggestions' });
  expect(before(heading, reads)).toBe(true);
  expect(before(reads, input)).toBe(true);
  expect(before(input, chips)).toBe(true);
  // No log until the first message; one column, at most 760px wide, centered top to bottom.
  expect(screen.queryByRole('log')).toBeNull();
  const column = screen.getByTestId('chat-landing-column');
  expect(style(column).maxWidth).toBe('760px');
  expect(style(column).justifyContent).toBe('center');
  // The chips are pills (D26), and the landing's placeholder doesn't repeat them.
  expect(style(within(chips).getByRole('button', { name: 'Which days last month were unusual?' })).borderTopLeftRadius).toBe('22px');
  expect(input.getAttribute('placeholder')).toBe('Ask about a closure, an event or an unusual day');
  expect(screen.queryByText(BUDGET_LINE)).toBeNull();
});

test('the first send docks the composer under the thread', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  await send(api, 'How was December?');
  const log = screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
  expect(within(log).getByText('How was December?')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Ask TownwiseAI about Main Street Bar' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
  const input = screen.getByLabelText(COMPOSER_LABEL);
  expect(log.contains(input)).toBe(false);
  expect(before(log, input)).toBe(true);
  // Focus went with it, and the docked composer offers the Ask chips as rotating examples.
  await waitFor(() => { expect(document.activeElement).toBe(input); });
  expect(input.getAttribute('placeholder')).toBe('Which days last month were unusual?');
  // The messages sit in one centered column, at most 760px wide.
  expect(style(screen.getByTestId('chat-column')).maxWidth).toBe('760px');
});

test('a first turn taken back brings the landing back, with the text and focus in its composer', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  // The server refuses the turn, then the connection fails before anything arrives.
  const failures: ((next: () => void) => Promise<void>)[] = [
    async (next) => {
      api.refuse = chatRefusal(503, null);
      next();
      await waitFor(() => { expect(screen.queryByRole('log')).toBeNull(); });
      api.refuse = null;
    },
    async (next) => {
      next();
      await waitFor(() => { expect(api.turns).toHaveLength(1); });
      const docked = screen.getByLabelText(COMPOSER_LABEL);
      await waitFor(() => { expect(document.activeElement).toBe(docked); });
      await stream(() => { turn(api).fail(new ApiError('network', 'The network request failed.')); });
    },
  ];
  for (const fail of failures) {
    const input = await screen.findByLabelText(COMPOSER_LABEL);
    act(() => { input.focus(); });
    fireEvent.change(input, { target: { value: 'How was December?' } });
    await fail(() => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(await screen.findByRole('heading', { level: 2, name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
    const back = screen.getByLabelText(COMPOSER_LABEL);
    expect((back as HTMLTextAreaElement).value).toBe('How was December?');
    await waitFor(() => { expect(document.activeElement).toBe(back); });
    fireEvent.change(back, { target: { value: '' } });
  }
});

describe('the composer', () => {
  test('Enter sends; Shift+Enter is a new line; Enter while an input method composes does nothing', async () => {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    const input = await screen.findByLabelText(COMPOSER_LABEL);
    expect(input.getAttribute('aria-describedby')).toBe('composer-help');
    expect(document.getElementById('composer-help')?.textContent).toBe('Leave out guest names. TownwiseAI answers from your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data.');
    fireEvent.change(input, { target: { value: 'Closed Monday' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(api.turns).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    expect(turn(api).body).toEqual({ content: 'Closed Monday' });
  });

  test('a counter shows from 3,600 characters, and the field takes at most 4,000', async () => {
    renderAt('/locations/l1/agent', fakeChatApi());
    const input = await screen.findByLabelText(COMPOSER_LABEL);
    expect(input.getAttribute('maxlength')).toBe('4000');
    fireEvent.change(input, { target: { value: 'x'.repeat(3599) } });
    expect(screen.queryByText(/of 4,000$/)).toBeNull();
    fireEvent.change(input, { target: { value: 'x'.repeat(3712) } });
    expect(screen.getByText('3,712 of 4,000')).toBeTruthy();
  });

  test('Stop and send stops the reply and sends what was typed, after the last saved message', async () => {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    await send(api, 'How was December?');
    await stream(() => { turn(api).emit('text', { delta: 'December was' }); });
    const input = screen.getByLabelText(COMPOSER_LABEL);
    fireEvent.change(input, { target: { value: 'And January?' } });
    // Enter does nothing while a reply streams.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.turns).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop and send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(2); });
    expect(turn(api).body).toEqual({ content: 'And January?' });
    expect(screen.getByText('Stopped. Your message and this reply weren’t saved.')).toBeTruthy();
  });
});

test('History closes on Escape and gives focus back to its button', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  const button = await screen.findByRole('button', { name: 'History' });
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const list = screen.getByRole('region', { name: 'History' });
  expect(within(list).getByRole('button', { name: 'Earlier chat, Nov 2, 2026' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: 'History' })).toBeNull();
  expect(document.activeElement).toBe(button);
});

test('deleting the open conversation shows the landing and gives focus to History, as any delete does', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  await openEarlierChat();
  const history = screen.getByRole('button', { name: 'History' });
  fireEvent.click(history);
  const remove = screen.getByRole('button', { name: 'Delete Earlier chat' });
  act(() => { remove.focus(); });
  fireEvent.click(remove);
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
  await waitFor(() => { expect(document.activeElement).toBe(history); });
});

describe('on phones, where the header scrolls with the landing or the thread and is drawn anew when one replaces the other', () => {
  test('opening a conversation from the landing, or New chat from the thread, leaves focus in the composer', async () => {
    setWidth(360);
    renderAt('/locations/l1/agent', fakeChatApi());
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    const row = screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' });
    act(() => { row.focus(); });
    fireEvent.click(row);
    await screen.findByText('We close for the holidays.');
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL)); });
    const fresh = screen.getByRole('button', { name: 'New chat' });
    act(() => { fresh.focus(); });
    fireEvent.click(fresh);
    expect(await screen.findByRole('heading', { level: 2, name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL)); });
  });

  test('deleting the open conversation leaves focus in the landing’s composer', async () => {
    setWidth(360);
    renderAt('/locations/l1/agent', fakeChatApi());
    await openEarlierChat();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const remove = screen.getByRole('button', { name: 'Delete Earlier chat' });
    act(() => { remove.focus(); });
    fireEvent.click(remove);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ask TownwiseAI about Main Street Bar' })).toBeTruthy();
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL)); });
  });

  test('opening the page puts focus nowhere new', async () => {
    setWidth(360);
    renderAt('/locations/l1/agent', fakeChatApi());
    const input = await screen.findByLabelText(COMPOSER_LABEL);
    expect(document.activeElement).not.toBe(input);
  });
});

test('the side panel is closed by default and opens as a column from 1024px and as a sheet below', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  const toggle = await screen.findByRole('button', { name: 'Questions and activity (2)' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByTestId('agent-side')).toBeNull();
  fireEvent.click(toggle);
  // A column beside the chat: the same button (the chat isn't drawn again), and no dialog.
  const side = await screen.findByTestId('agent-side');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.isConnected).toBe(true);
  expect(within(side).getByRole('heading', { name: 'Questions for you' })).toBeTruthy();
  expect(within(side).getByRole('heading', { name: 'What it’s been doing' })).toBeTruthy();
  expect(within(side).getByRole('heading', { name: 'This month’s budget' })).toBeTruthy();
  expect(within(side).getByRole('button', { name: 'How TownwiseAI works' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Questions and activity' })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.queryByTestId('agent-side')).toBeNull();
  // Below 1024px, a full-screen sheet: Escape shuts it and focus goes back to the button.
  setWidth(800);
  const narrow = screen.getByRole('button', { name: 'Questions and activity (2)' });
  fireEvent.click(narrow);
  const sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
  expect(within(sheet).getByRole('heading', { name: 'Questions for you' })).toBeTruthy();
  pressEscape();
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Questions and activity' })).toBeNull(); });
  expect(document.activeElement).toBe(narrow);
});

test('below 1024px, Escape in the model card closes only the card, and focus goes back to How Townwise estimates', async () => {
  setWidth(800);
  renderAt('/locations/l1/agent', fakeChatApi());
  fireEvent.click(await screen.findByRole('button', { name: 'Questions and activity (2)' }));
  const sheet = await screen.findByRole('dialog', { name: 'Questions and activity' });
  fireEvent.click(within(sheet).getByRole('button', { name: 'How TownwiseAI works' }));
  const estimates = within(sheet).getByRole('button', { name: 'How Townwise estimates' });
  act(() => { estimates.focus(); });
  fireEvent.click(estimates);
  expect(await screen.findByRole('dialog', { name: 'How Townwise estimates' })).toBeTruthy();
  pressEscape();
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'How Townwise estimates' })).toBeNull(); });
  expect(screen.getByRole('dialog', { name: 'Questions and activity' })).toBe(sheet);
  expect(document.activeElement).toBe(estimates);
});

test('shows the 80% budget line above the composer', async () => {
  const api = fakeChatApi();
  api.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 16 } };
  renderAt('/locations/l1/agent', api);
  const line = await screen.findByText(BUDGET_LINE);
  expect(before(line, screen.getByLabelText(COMPOSER_LABEL))).toBe(true);
  await send(api, 'How was December?');
  expect(before(screen.getByText(BUDGET_LINE), screen.getByLabelText(COMPOSER_LABEL))).toBe(true);
  expect(screen.getAllByText(BUDGET_LINE)).toHaveLength(1);
});

test('shows exactly three next questions under the newest settled reply only, the model’s when given', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  await send(api, 'How was December?');
  const model = ['Show December as a chart', 'Compare December with November', 'Which December days were slow?'];
  await stream(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'How was December?' });
    turn(api).emit('text', { delta: 'December was steady.' });
    turn(api).emit('suggestions', { id: 'toolu_test_0009', prompts: model });
  });
  // Not while it streams.
  expect(screen.queryByRole('group', { name: 'Suggested next questions' })).toBeNull();
  await stream(() => {
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  const group = screen.getByRole('group', { name: 'Suggested next questions' });
  expect(within(group).getAllByRole('button').map((chip) => chip.textContent)).toEqual(model);
  // One press sends it; none show under the reply that streams, and the earlier reply's go.
  fireEvent.click(within(group).getByRole('button', { name: 'Compare December with November' }));
  await waitFor(() => { expect(api.turns).toHaveLength(2); });
  expect(turn(api).body).toMatchObject({ content: 'Compare December with November' });
  expect(screen.queryByRole('group', { name: 'Suggested next questions' })).toBeNull();
  // A reply that came with none gets three by the fixed rules, never the message just sent.
  await stream(() => {
    turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
    turn(api).emit('text', { delta: 'November was quieter.' });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  const groups = screen.getAllByRole('group', { name: 'Suggested next questions' });
  expect(groups).toHaveLength(1);
  expect(within(first(groups)).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
    'Show that as a chart', 'Compare that with the same days last year', 'Is anything on the town calendar then?',
  ]);
});

test('a pressed next question goes with its group, and focus goes to the composer, where Stop is, not to the page', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  await send(api, 'How was December?');
  await stream(() => {
    turn(api).emit('text', { delta: 'December was steady.' });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  const chip = first(within(screen.getByRole('group', { name: 'Suggested next questions' })).getAllByRole('button'));
  act(() => { chip.focus(); });
  fireEvent.click(chip);
  await waitFor(() => { expect(api.turns).toHaveLength(2); });
  expect(screen.queryByRole('group', { name: 'Suggested next questions' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText(COMPOSER_LABEL));
});

test('F7: ?about= fills the composer with the day, sends nothing, and keeps the address', async () => {
  const api = fakeChatApi();
  const date = localToday();
  renderAt(`/locations/l1/agent?about=${date}`, api);
  const input = await screen.findByLabelText(COMPOSER_LABEL);
  await waitFor(() => { expect((input as HTMLTextAreaElement).value).toBe(aboutDraft(date, date)); });
  expect(api.turns).toHaveLength(0);
  expect(window.location.pathname).toBe('/locations/l1/agent');
  // The person sends it with Enter, as anything they typed.
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  expect(turn(api).body).toEqual({ content: aboutDraft(date, date) });
});

test('F7: a malformed ?about= leaves the composer empty', async () => {
  renderAt('/locations/l1/agent?about=2026-13-01', fakeChatApi());
  const input = await screen.findByLabelText(COMPOSER_LABEL);
  expect((input as HTMLTextAreaElement).value).toBe('');
});

test('F10: How Townwise estimates opens the model card as a dialog; Escape closes it', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  const side = await openPanel();
  fireEvent.click(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
  fireEvent.click(within(side).getByRole('button', { name: 'How Townwise estimates' }));
  const dialog = await screen.findByRole('dialog', { name: 'How Townwise estimates' });
  expect(await within(dialog).findByText('Townwise has no forecast for Main Street Bar yet. Home and TownwiseAI use your history and Hanover’s calendar until it does.')).toBeTruthy();
  // react-native-web's Modal closes on Escape's keyup.
  fireEvent.keyUp(document, { key: 'Escape' });
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'How Townwise estimates' })).toBeNull(); });
});

test('the forecast line says a lab run was trained on the sales history and notes uploaded to Townwise', async () => {
  const chat = serveAbout(fakeChatApi(), { ...PUBLISHED, forecast: { run: { ...RUN, trainingSource: 'townwise_lab' }, live: null } });
  renderAt('/locations/l1/agent', chat);
  // The panel is behind the header's toggle in the redesign (D26).
  const side = await openPanel();
  fireEvent.click(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
  expect(await within(side).findByText('TownwiseAI also reads the forecast Townwise published: Townwise demand model v9, trained on sales history and notes you uploaded to Townwise from Jan 1, 2025 to Oct 21, 2026, made Nov 1, 2026.')).toBeTruthy();
});

test('the forecast line reads a training source this client doesn’t know as sales history', async () => {
  const chat = serveAbout(fakeChatApi(), { ...PUBLISHED, forecast: { run: { ...RUN, trainingSource: 'a_future_source' }, live: null } });
  renderAt('/locations/l1/agent', chat);
  // The panel is behind the header's toggle in the redesign (D26).
  const side = await openPanel();
  fireEvent.click(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
  expect(await within(side).findByText('TownwiseAI also reads the forecast Townwise published: Townwise demand model v9, trained on sales history from Jan 1, 2025 to Oct 21, 2026, made Nov 1, 2026.')).toBeTruthy();
});

describe('a tool card', () => {
  async function running(api: FakeChatApi): Promise<HTMLElement> {
    renderAt('/locations/l1/agent', api);
    await send(api, 'How was December?');
    await stream(() => { turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: SALES_STEP.input, result: null }); });
    return screen.getByText('your sales for Dec 1 to Dec 31, 2025');
  }

  function faded(element: HTMLElement): boolean {
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      if (node.style.opacity !== '') return true;
    }
    return false;
  }

  test('fades in as it starts', async () => {
    reduceMotion(false);
    expect(faded(await running(fakeChatApi()))).toBe(true);
  });

  test('under reduced motion appears at once, with nothing animated', async () => {
    reduceMotion(true);
    expect(faded(await running(fakeChatApi()))).toBe(false);
  });

  test('a running tool shows as its row in the timeline instead of Thinking…, and the caret goes on done', async () => {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    await send(api, 'How was December?');
    expect(screen.getByText('Working for 0s')).toBeTruthy();
    expect(screen.getByText('Thinking…')).toBeTruthy();
    expect(screen.queryByText('TownwiseAI is thinking…')).toBeNull();
    await stream(() => { turn(api).emit('thinking', { delta: 'Weighing the weekend.' }); });
    expect(screen.getByText('Weighing the weekend.')).toBeTruthy();
    expect(screen.queryByText('Thinking…')).toBeNull();
    await stream(() => { turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: SALES_STEP.input, result: null }); });
    expect(screen.getByText('your sales for Dec 1 to Dec 31, 2025')).toBeTruthy();
    await stream(() => {
      turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
      turn(api).emit('text', { delta: 'December was steady.' });
    });
    // Text is what streams: the static caret ends it, and the live line has gone.
    expect(screen.getAllByText('▍')).toHaveLength(1);
    await stream(() => {
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(screen.queryByText('▍')).toBeNull();
    expect(screen.queryByText(/^Working for/)).toBeNull();
    // The timeline folds under a collapsed Worked for, which opens to the summary and the step.
    expect(screen.queryByText('Weighing the weekend.')).toBeNull();
    const worked = screen.getByRole('button', { name: /^Worked for \d+ seconds?$/ });
    expect(worked.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(worked);
    expect(worked.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(worked.getAttribute('aria-controls') ?? '')).not.toBeNull();
    expect(screen.getByText('Weighing the weekend.')).toBeTruthy();
  });

  test('the live region says what it starts reading and never the streamed text or a figure', async () => {
    const api = fakeChatApi();
    await running(api);
    const live = liveRegion();
    const said: string[] = [];
    const listen = new MutationObserver(() => { said.push(live.textContent); });
    listen.observe(live, { subtree: true, childList: true, characterData: true });
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('Reading your sales for Dec 1 to Dec 31, 2025');
    await stream(() => {
      turn(api).emit('thinking', { delta: 'Sentinel thinking words.' });
      turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
      turn(api).emit('text', { delta: 'December had 1,234 guests.' });
    });
    expect(live.textContent).toBe('TownwiseAI is replying');
    // The log is not live (a log is polite by default), so the streamed text is never read out: the nearest live
    // setting above it is the log's "off", and the page's region is the only polite one with anything to say.
    const log = screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
    expect(log.getAttribute('aria-live')).toBe('off');
    expect(screen.getByText(/December had 1,234 guests/).closest('[aria-live]')).toBe(log);
    expect(Array.from(document.querySelectorAll('[aria-live="polite"]')).filter((region) => region.textContent !== '')).toEqual([live]);
    await stream(() => {
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(live.textContent).toBe('TownwiseAI replied');
    // Neither the counter nor the thinking text was ever said.
    expect(said.join('|')).not.toContain('Working for');
    listen.disconnect();
    for (const words of said) expect(words).not.toMatch(/1,234|guests|December had|Sentinel/);
  });

  test('opening an earlier conversation announces nothing: only a reply to this visit’s message is news', async () => {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    await openEarlierChat();
    expect(screen.getByText('Last December you were open every day.')).toBeTruthy();
    const live = liveRegion();
    expect(live.textContent).toBe('');
    fireEvent.change(screen.getByLabelText(COMPOSER_LABEL), { target: { value: 'And January?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('text', { delta: 'January was quiet.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(live.textContent).toBe('TownwiseAI replied');
    // Opening it again replays the reply, which is not news.
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    await waitFor(() => { expect(live.textContent).toBe(''); });
  });

  test('a version switch says which version shows, through the page’s region, and nothing about a reply', async () => {
    const api = fakeChatApi();
    api.conversation = TWO_REPLIES;
    api.versions = { a2: SECOND_REPLY };
    renderAt('/locations/l1/agent', api);
    await openEarlierChat();
    const live = liveRegion();
    fireEvent.change(screen.getByLabelText(COMPOSER_LABEL), { target: { value: 'And January?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('text', { delta: 'January was quiet.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(live.textContent).toBe('TownwiseAI replied');
    // A switch draws every message anew; none of it is a reply to say.
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
    expect(live.textContent).toBe('');
    expect(await screen.findByText('A second answer.')).toBeTruthy();
    await waitFor(() => { expect(live.textContent).toBe('Showing version 2 of 2.'); });
    expect(api.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/chat/c1/active', body: { nodeId: 'a2' } }]);
  });
});

test('one primary: only the composer’s button has the white fill', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  // A reply with a proposal card, the side panel's answers, and text in the composer, so Send is on.
  await openEarlierChat();
  expect(screen.getByText('Proposed note')).toBeTruthy();
  const side = await openPanel();
  await within(side).findByRole('button', { name: 'Yes, closed Mondays' });
  fireEvent.change(screen.getByLabelText(COMPOSER_LABEL), { target: { value: 'And January?' } });
  const send = screen.getByRole('button', { name: 'Send' });
  expect(screen.getAllByRole('button').filter((button) => style(button).backgroundColor === WHITE)).toEqual([send]);
  expect(style(send).borderTopLeftRadius).toBe('22px');
  // Edit first's note form saves with an outline, so it stays the one.
  fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));
  expect(await screen.findByRole('heading', { name: 'Add a note' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save note' })).toBeTruthy();
  expect(screen.getAllByRole('button').filter((button) => style(button).backgroundColor === WHITE)).toEqual([send]);
});

test('no horizontal page scroll at 360px with a wide table and a chart', async () => {
  setWidth(360);
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  await send(api, 'Show me October');
  const columns = Array.from({ length: 12 }, (_, index) => `Column ${String(index + 1)}`);
  const table = [`| ${columns.join(' | ')} |`, `|${' --- |'.repeat(12)}`, `| ${columns.map(() => 'a long value').join(' | ')} |`].join('\n');
  await stream(() => {
    turn(api).emit('text', { delta: `October, day by day:\n\n${table}\n` });
    turn(api).emit('visual', { id: 'toolu_test_0010', visual: daily });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  const log = screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
  // The thread never scrolls sideways; its column is the screen's width at most.
  expect(style(log).overflowX).toBe('hidden');
  const column = screen.getByTestId('chat-column');
  expect(style(column).width).toBe('100%');
  expect(style(column).minWidth).toBe('0px');
  // The table scrolls inside its own region, and the chart is as wide as the column.
  const region = within(log).getByRole('region', { name: 'Table' });
  expect(style(region).overflowX).toBe('auto');
  expect(within(region).getByText('Column 12')).toBeTruthy();
  expect((log.querySelector('svg') as SVGElement | null)?.style.width).toBe('100%');
  // The next questions scroll sideways inside their own row on phones.
  const next = screen.getByRole('group', { name: 'Suggested next questions' });
  expect(style(first(Array.from(next.children))).overflowX).toBe('auto');
});

test('a town profile card’s sources open in a new tab', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  await send(api, 'What drives Hanover?');
  const result = { available: true, town: { name: 'Hanover', state: 'NH' }, sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/calendar' }] };
  await stream(() => {
    turn(api).emit('tool', { id: 'toolu_test_0003', name: 'get_town_profile', state: 'done', input: null, result });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  expect(screen.getByText('Based on Hanover’s town profile (dartmouth.edu).')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Worked for/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Read Hanover’s town profile. dartmouth.edu' }));
  const link = screen.getByRole('link', { name: 'dartmouth.edu' });
  expect(link.getAttribute('href')).toBe('https://dartmouth.edu/calendar');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
});

test('under view-as every write is disabled in place, the name prompt never shows, and versions still switch by reading', async () => {
  const api = fakeChatApi();
  // The server never asks under view-as; the page wouldn't either.
  api.profile = { displayName: 'Pat', askName: true };
  api.conversation = TWO_REPLIES;
  api.versions = { a2: SECOND_REPLY };
  renderAt('/locations/l1/agent', api, viewAsMe(ACCESS.member));
  await waitFor(() => { expect(document.getElementById('chat-ro')).toBeTruthy(); });
  // It greets with the target's name, as the target sees it.
  expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back, Pat.' })).toBeTruthy();
  expect(screen.queryByText('What should TownwiseAI call you?')).toBeNull();
  const input = await screen.findByLabelText(COMPOSER_LABEL);
  expect(input.getAttribute('aria-readonly')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toBe('chat-ro composer-help');
  for (const name of ['Send', 'New chat', 'Which days last month were unusual?']) expectReadOnly(screen.getByRole('button', { name }));
  const side = await openPanel();
  expectReadOnly(await within(side).findByRole('button', { name: 'Yes, closed Mondays' }));
  fireEvent.click(within(side).getByRole('button', { name: 'Yes, closed Mondays' }));
  // Reading is allowed: the target's conversation opens, with every action in place and disabled.
  await openEarlierChat();
  // The docked composer shows no example to accept, so Tab can't fill it.
  const docked = screen.getByLabelText(COMPOSER_LABEL);
  expect(docked.getAttribute('placeholder')).toBe('Ask about a closure, an event or an unusual day');
  fireEvent.keyDown(docked, { key: 'Tab' });
  expect((docked as HTMLTextAreaElement).value).toBe('');
  const next = screen.getByRole('group', { name: 'Suggested next questions' });
  for (const control of [
    screen.getByRole('button', { name: 'Edit' }), screen.getByRole('button', { name: 'Regenerate' }),
    screen.getByRole('button', { name: 'Helpful' }), screen.getByRole('button', { name: 'Not helpful' }),
    screen.getByRole('button', { name: 'Save note' }), first(within(next).getAllByRole('button')),
  ]) {
    expectReadOnly(control);
    fireEvent.click(control);
  }
  // A version switch reads the other version by its node and stores nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
  expect(await screen.findByText('A second answer.')).toBeTruthy();
  expect(api.conversationReads.at(-1)).toBe('/api/org/locations/l1/chat/c1?node=a2');
  expect(api.turns).toHaveLength(0);
  expect(api.writes).toHaveLength(0);
  expect(screen.getAllByText(/^Read-only while viewing as/)).toHaveLength(1);
});

describe('order cards (#68 review N6, design Decision 6)', () => {
  const CHANGE_ID = 'toolu_order_0001';
  const RULE_ID = 'toolu_order_0002';
  const ITEM = 'a'.repeat(24);
  const CHANGE = `/api/org/locations/l1/chat/c2/order-proposals/${CHANGE_ID}`;
  const RULE = `/api/org/locations/l1/chat/c2/order-proposals/${RULE_ID}`;

  async function proposed(api: FakeChatApi): Promise<void> {
    renderAt('/locations/l1/agent', api);
    fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'Order more lager this week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('conversation', { id: 'c2', title: 'Lager' });
      turn(api).emit('tool', { id: CHANGE_ID, name: 'propose_order_change', state: 'done', input: { itemId: ITEM, delivery: '2026-11-19' }, result: { shown: true } });
      turn(api).emit('tool', { id: RULE_ID, name: 'propose_order_rule', state: 'done', input: { itemId: ITEM }, result: { shown: true } });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
  }

  test('a change card sends a whole-number quantity and a reason, never an empty or non-numeric one', async () => {
    const api = fakeChatApi();
    const view = { kind: 'change', status: 'open', itemId: ITEM, delivery: '2026-11-19' };
    api.reads[CHANGE] = () => ({ proposal: view });
    api.reads[RULE] = () => ({ proposal: { kind: 'rule', status: 'open', itemId: ITEM, situation: 'a football weekend', delta: 2, unit: 'cases' } });
    api.respond[CHANGE] = () => ({ proposal: { ...view, status: 'saved', quantity: 10, reason: 'Game day' } });
    await proposed(api);
    const quantity = await screen.findByLabelText('Quantity');
    // The rule card says its change goes on every later order.
    expect(screen.getByText('Adds 2 cases to every order: “a football weekend”')).toBeTruthy();
    expect(screen.getByText('It applies to every later order of this item until you turn it off on Orders.')).toBeTruthy();
    const save = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); };
    for (const text of ['', 'ten', '2.5']) {
      fireEvent.change(quantity, { target: { value: text } });
      fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Game day' } });
      save();
      expect(screen.getByText('Enter a whole number from 0 to 999.')).toBeTruthy();
    }
    fireEvent.change(quantity, { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: '  ' } });
    save();
    expect(screen.getByText('Say why, in a few words.')).toBeTruthy();
    expect(api.writes.filter((write) => write.path === CHANGE)).toEqual([]);
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Game day' } });
    save();
    expect(await screen.findByText('Saved for this order.')).toBeTruthy();
    expect(api.writes.filter((write) => write.path === CHANGE)).toEqual([
      { method: 'POST', path: CHANGE, body: { action: 'save', quantity: 10, reason: 'Game day' } },
    ]);
  });

  // #68 review A5: Remember sends the situation the card showed; a later edit to the item answers 409 rule_changed.
  test('a rule card sends the situation it showed; 409 rule_changed asks to look at Orders again', async () => {
    const api = fakeChatApi();
    api.reads[CHANGE] = () => ({ proposal: { kind: 'change', status: 'open', itemId: ITEM, delivery: '2026-11-19' } });
    api.reads[RULE] = () => ({ proposal: { kind: 'rule', status: 'open', itemId: ITEM, situation: 'a football weekend', delta: 2, unit: 'cases' } });
    let answer: unknown = chatRefusal(409, 'rule_changed');
    api.respond[RULE] = () => answer;
    await proposed(api);
    await screen.findByText('Adds 2 cases to every order: “a football weekend”');
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }));
    expect(await screen.findByText('This item’s latest edit changed since this card was shown, so nothing was remembered. Look at Orders again for the edit it has now.')).toBeTruthy();
    answer = { proposal: { kind: 'rule', status: 'saved', itemId: ITEM, situation: 'a football weekend', delta: 2, unit: 'cases' } };
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }));
    expect(await screen.findByText('Remembered.')).toBeTruthy();
    expect(api.writes.filter((write) => write.path === RULE).map((write) => write.body)).toEqual([
      { action: 'save', situation: 'a football weekend' }, { action: 'save', situation: 'a football weekend' },
    ]);
  });
});

// #68 review C8: an order link from Orders fills the composer only from the location's own live board.
describe('an order link (?order=, &item=)', () => {
  const BOARD_PATH = '/api/org/locations/l1/orders';
  const LINE = {
    itemId: 'lager', name: 'Sample lager', supplier: 'Sample distributor', unit: 'cases', neverRunOut: false, recommended: 6, alternative: null,
    par: 2, mu: null, sigma: null, orderUpTo: null, target: 0.95, onHand: null, countAgeDays: null, confidence: 'low', dealSize: null,
    coveredDays: 0, why: 'No count, so this is the par.', sample: false, edit: null, rules: [],
  };
  const BOARD = {
    available: true, today: '2026-11-13', sample: false, missing: [],
    orders: [{
      supplierId: 's1', supplier: 'Sample distributor', cutoff: '2026-11-18', cutoffTime: '14:00', delivery: '2026-11-19', coversThrough: '2026-11-23',
      deadline: 'Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.', lines: [LINE],
    }],
  };

  async function composerAfter(path: string, api: FakeChatApi): Promise<HTMLTextAreaElement> {
    renderAt(path, api);
    const composer = await screen.findByLabelText(COMPOSER_LABEL);
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    return composer as HTMLTextAreaElement;
  }

  test('the live board drafts the question; an unavailable board drafts nothing and never reads the sample', async () => {
    const live = fakeChatApi();
    live.reads[BOARD_PATH] = () => BOARD;
    const composer = await composerAfter('/locations/l1/agent?order=2026-11-19&item=lager', live);
    await waitFor(() => { expect(composer.value).toBe('Why Sample lager for the Thu, Nov 19 delivery?'); });
    // Drafts are kept in memory per person and location, so each render starts from none.
    cleanup();
    resetDrafts();

    const unset = fakeChatApi();
    let sampleReads = 0;
    unset.reads[BOARD_PATH] = () => ({ available: false, today: '2026-11-13', reason: 'No setup.', missing: ['the items'] });
    unset.reads[`${BOARD_PATH}?sample=true`] = () => { sampleReads += 1; return { ...BOARD, sample: true }; };
    expect((await composerAfter('/locations/l1/agent?order=2026-11-19&item=lager', unset)).value).toBe('');
    expect(sampleReads).toBe(0);
    cleanup();
    resetDrafts();

    // A sample board, should one come back, drafts nothing either.
    const sample = fakeChatApi();
    sample.reads[BOARD_PATH] = () => ({ ...BOARD, sample: true });
    expect((await composerAfter('/locations/l1/agent?order=2026-11-19', sample)).value).toBe('');
  });
});

describe('a proposal to keep text (D28)', () => {
  const ITEM_ID = 'toolu_item_0001';
  const PATH = `/api/org/locations/l1/chat/c2/item-proposals/${ITEM_ID}`;
  const VIEW = { id: ITEM_ID, title: 'Catering list', text: 'Party of 40 on Dec 12', status: 'open', item: null };

  async function proposedItem(api: FakeChatApi): Promise<HTMLElement> {
    renderAt('/locations/l1/agent', api);
    fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'Keep this: Party of 40 on Dec 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('conversation', { id: 'c2', title: 'Keep this' });
      turn(api).emit('tool', { id: ITEM_ID, name: 'propose_data_item', state: 'running', input: { chars: 21 }, result: null });
      turn(api).emit('tool', { id: ITEM_ID, name: 'propose_data_item', state: 'done', input: { chars: 21 }, result: { shown: true } });
    });
    return screen.getByRole('group', { name: 'Proposed for Your data' });
  }

  test('the item card loads its text, keeps it, and announces Kept on Your data.', async () => {
    const api = fakeChatApi();
    api.reads[PATH] = () => ({ proposal: VIEW });
    api.respond[PATH] = () => ({
      proposal: { ...VIEW, status: 'saved', item: itemOf('f_kept', { name: 'Catering list.txt', via: 'townwise_ai', state: 'kept', outcome: 'reference' }) },
    });
    const card = await proposedItem(api);
    // Until the turn is stored, the card waits: the text is never streamed, only read from the card's own route.
    expect(within(card).getByText('The text shows here when this reply finishes.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Keep on Your data' })).toBeNull();
    expect(screen.queryByText(/text to keep on Your data/)).toBeNull();
    await stream(() => {
      turn(api).emit('text', { delta: 'I showed it to you as a card.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(await within(card).findByText('Party of 40 on Dec 12')).toBeTruthy();
    expect(within(card).getByText('Catering list')).toBeTruthy();
    expect(within(card).getByRole('region', { name: 'Text of Catering list' }).getAttribute('tabindex')).toBe('0');
    // A proposal is not something TownwiseAI read.
    expect(screen.getByText('Based on this conversation only.')).toBeTruthy();
    // Keep is an outline, so the composer's button stays the page's one primary (D26).
    expect(style(within(card).getByRole('button', { name: 'Keep on Your data' })).backgroundColor).not.toBe(WHITE);
    fireEvent.click(within(card).getByRole('button', { name: 'Keep on Your data' }));
    const kept = await within(card).findByText('Kept on Your data.');
    await waitFor(() => { expect(document.activeElement?.contains(kept)).toBe(true); });
    expect(api.writes.filter((write) => write.path === PATH)).toEqual([{ method: 'POST', path: PATH, body: { action: 'save' } }]);
    expect(within(card).getByRole('link', { name: 'Open Your data' }).getAttribute('href')).toBe('/locations/l1/data');
  });

  test('Not now folds the card, which can be shown again; a refused Keep says why on the card', async () => {
    const api = fakeChatApi();
    api.reads[PATH] = () => ({ proposal: VIEW });
    let answer: unknown = { proposal: { ...VIEW, status: 'dismissed' } };
    api.respond[PATH] = () => answer;
    const card = await proposedItem(api);
    await stream(() => {
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    fireEvent.click(await within(card).findByRole('button', { name: 'Not now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show the text' }));
    answer = chatRefusal(409, 'storage_full');
    const again = screen.getByRole('group', { name: 'Proposed for Your data' });
    fireEvent.click(within(again).getByRole('button', { name: 'Keep on Your data' }));
    expect(await within(again).findByText('Your organization’s file storage is full. Delete some originals to make room.')).toBeTruthy();
    expect(within(again).getByRole('button', { name: 'Keep on Your data' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  test('a reply that wasn’t saved has nothing to keep, and a call that showed nothing has no card', async () => {
    const api = fakeChatApi();
    const card = await proposedItem(api);
    await stream(() => {
      turn(api).emit('tool', { id: 'toolu_item_0002', name: 'propose_data_item', state: 'done', input: { chars: 3 }, result: { shown: false } });
      turn(api).fail(chatRefusal(500, 'internal'));
    });
    expect(within(card).getByText('This reply wasn’t saved, so there’s nothing to keep from it. Paste the text on Your data to keep it.')).toBeTruthy();
    expect(screen.getAllByRole('group', { name: 'Proposed for Your data' })).toHaveLength(1);
    expect(api.writes.filter((write) => write.path.includes('item-proposals'))).toEqual([]);
  });

  test('view-as: the card reads, and Keep and Not now are disabled in place, described by the read-only line', async () => {
    const api = fakeChatApi();
    api.reads['/api/org/locations/l1/chat/c1/item-proposals/toolu_item_0001'] = () => ({ proposal: { ...VIEW } });
    // A stored conversation as the redesign reads it (a tree, its path's messages under their nodes).
    api.conversation = {
      ...CONVERSATION,
      messages: [
        { nodeId: 'u1', role: 'user', text: 'Keep this.', proposals: [], parts: [], at: '2026-11-02T14:59:00.000Z' },
        {
          nodeId: 'a1', role: 'assistant', text: '', proposals: [], at: '2026-11-02T15:00:00.000Z',
          parts: [{ type: 'tool', id: ITEM_ID, name: 'propose_data_item', state: 'done', input: { chars: 21 }, result: { shown: true } }],
        },
      ],
    };
    renderAt('/locations/l1/agent', api, viewAsMe(ACCESS.member));
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    const card = await screen.findByRole('group', { name: 'Proposed for Your data' });
    expect(await within(card).findByText('Party of 40 on Dec 12')).toBeTruthy();
    // The call is the card, never a step: nothing in the timeline or the Based on line names it.
    expect(screen.queryByText(/text to keep on Your data/)).toBeNull();
    expect(screen.getByText('Based on this conversation only.')).toBeTruthy();
    for (const name of ['Keep on Your data', 'Not now']) {
      const control = within(card).getByRole('button', { name });
      expectReadOnly(control);
      fireEvent.click(control);
    }
    expect(api.writes).toHaveLength(0);
  });
});

test('nothing goes to browser storage', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  try {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    await send(api, 'Hello');
    // A draft typed while the reply streams is kept in memory only.
    fireEvent.change(screen.getByLabelText(COMPOSER_LABEL), { target: { value: 'Half typed' } });
    await stream(() => {
      turn(api).emit('text', { delta: 'Hi.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    const side = await openPanel();
    const [notSure] = await within(side).findAllByRole('button', { name: 'Not sure' });
    if (notSure === undefined) throw new Error('no answer');
    fireEvent.click(notSure);
    await within(side).findByText('Got it. TownwiseAI won’t ask about these days again.');
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
});
