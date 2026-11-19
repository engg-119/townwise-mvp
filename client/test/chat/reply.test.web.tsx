import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Animated } from 'react-native';

import type { ToolContext, ToolStep } from '../../src/chat/tools';
import type { TreeNode } from '../../src/chat/tree';
import { initialChatState, type ChatMessage, type MessagePart, type TuningChat, type TuningChatState } from '../../src/chat/useTuningChat';
import { NextChips } from '../../src/chat/ui/NextChips';
import { COLLAPSE_MS } from '../../src/chat/ui/Collapse';
import { ReplyView } from '../../src/chat/ui/ReplyView';
import { UserMessage } from '../../src/chat/ui/UserMessage';
import { workedOpenStore } from '../../src/chat/ui/workedOpen';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { visualTitle } from '../../src/chat/visuals/words';
import { PortalStyles } from '../../src/portal/shell/PortalStyles.web';
import { theme } from '../../src/theme';
import { PROPOSAL, PROPOSAL_ID, SALES_STEP } from '../helpers/chat';
import { ACCESS, meOf, viewAsMe } from '../helpers/portal';
import { daily, weekdays } from './visuals-fixtures';

// B6 on web: the person's message bubbles and TownwiseAI's replies (owner decisions 3 to 6): the caret and the live
// line, Markdown and visuals in order, Copy, Regenerate, the ratings, editing a message, the version navigator and
// its focus, the hidden speaker labels, wrapping, and the next questions.

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

const writeText = jest.fn<Promise<void>, [string]>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  resetVersionFocus();
  Reflect.deleteProperty(navigator, 'clipboard');
  jest.useRealTimers();
  setWidth(1280);
});

const CTX: ToolContext = { town: 'Hanover', hasTownProfile: true };
// On web theme.color is var(--tw-<token>), which jsdom leaves unresolved, so a computed color names its token.
const MINT = theme.color.mint;

function fakeChat(over: Partial<TuningChat> = {}, state: Partial<TuningChatState> = {}): TuningChat {
  return {
    state: {
      ...initialChatState(), status: 'ready', enabled: true, conversationId: 'c1',
      budget: { month: '2026-11', usedUsd: 1, limitUsd: 20, exhausted: false }, ...state,
    },
    setDraft: jest.fn(), send: jest.fn(), ask: jest.fn(), tell: jest.fn(), stop: jest.fn(), stopAndSend: jest.fn(), newConversation: jest.fn(),
    openConversation: jest.fn(), deleteConversation: jest.fn(() => Promise.resolve()), rename: jest.fn(() => Promise.resolve()),
    save: jest.fn(), saveEdited: jest.fn(() => Promise.resolve()), edit: jest.fn(), cancelEdit: jest.fn(), dismiss: jest.fn(),
    reopen: jest.fn(), editMessage: jest.fn(), regenerate: jest.fn(), showVersion: jest.fn(), rate: jest.fn(), retry: jest.fn(),
    reload: jest.fn(), watchList: jest.fn(),
    // D28's item card: never answered unless a test says so.
    loadItem: jest.fn(() => new Promise<never>(() => undefined)), keepItem: jest.fn(() => new Promise<never>(() => undefined)),
    setItemAside: jest.fn(() => new Promise<never>(() => undefined)), ...over,
  };
}

function text(key: string, value: string): MessagePart {
  return { type: 'text', key, text: value };
}

function msg(key: string, role: ChatMessage['role'], parts: MessagePart[], over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    key, role, parts, state: 'complete', note: null, nodeId: null, parentId: null, feedback: null, ratingError: null, next: null,
    request: null, startedAt: null, endedAt: null, at: null, attachments: [], sources: [], ...over,
  };
}

const TREE: TreeNode[] = [{ id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' }];
const ASKED = msg('m1', 'user', [text('m1t', 'How was December?')], { nodeId: 'u1' });
const SAVED = msg('m2', 'assistant', [text('m2t', 'December was busy.')], { nodeId: 'a1', parentId: 'u1' });

type ReplyProps = React.ComponentProps<typeof ReplyView>;
type UserProps = React.ComponentProps<typeof UserMessage>;

function replyProps(over: Partial<ReplyProps> = {}): ReplyProps {
  return {
    message: SAVED, ctx: CTX, tree: TREE, newest: true, actions: 'always', chat: fakeChat(), locationId: 'l1', readOnlyId: null, canAct: true,
    onRetry: jest.fn(), onAnnounce: jest.fn(), workedOpen: workedOpenStore(), ...over,
  };
}

function userProps(over: Partial<UserProps> = {}): UserProps {
  return { message: ASKED, tree: TREE, chat: fakeChat(), locationId: 'l1', readOnlyId: null, busy: false, actions: 'always', onAnnounce: jest.fn(), ...over };
}

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function first(elements: HTMLElement[]): HTMLElement {
  const element = elements[0];
  if (element === undefined) throw new Error('no element');
  return element;
}

function before(a: HTMLElement, b: HTMLElement): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

it('shows the caret only while the reply streams, and removes it on done, stop and failure', () => {
  const step: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: { ...SALES_STEP.input }, result: { ...SALES_STEP.result } };
  const live = msg('m2', 'assistant', [text('a', 'Let me look.'), { type: 'tools', key: 'b', steps: [step] }, text('c', 'So far')], { state: 'streaming' });
  const view = render(<ReplyView {...replyProps({ message: live })} />);
  // One caret, at the end of the last text part, hidden from assistive tech; no live line while text streams.
  expect(screen.getAllByText('▍')).toHaveLength(1);
  expect(first(screen.getAllByText('▍')).getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByText('So far').parentElement?.textContent).toBe('So far▍');
  expect(screen.queryByText('Thinking…')).toBeNull();
  for (const state of ['complete', 'stopped', 'failed'] as const) {
    view.rerender(<ReplyView {...replyProps({ message: { ...live, state } })} />);
    expect(screen.queryByText('▍')).toBeNull();
  }
  // Text followed by a running step: the step is a row in the timeline, and the caret is not left mid-reply.
  const running: ToolStep = { ...step, state: 'running', result: null };
  view.rerender(<ReplyView {...replyProps({ message: { ...live, parts: [text('a', 'Let me look.'), { type: 'tools', key: 'b', steps: [running] }] } })} />);
  expect(screen.queryByText('▍')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Working for/ }));
  expect(screen.getByText('your sales for Dec 1 to Dec 31, 2025')).toBeTruthy();
});

it('while it streams, only the counter shows until the thinking summary or a step arrives; then it is a closed button over them, in small text2', () => {
  const running: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: { ...SALES_STEP.input }, result: null };
  const view = render(<ReplyView {...replyProps({ message: msg('m2', 'assistant', [], { state: 'streaming' }) })} />);
  expect(screen.getByText('Working for 0s')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Working for/ })).toBeNull();
  expect(screen.queryByText('Thinking…')).toBeNull();
  expect(screen.queryByText('TownwiseAI is thinking…')).toBeNull();
  view.rerender(<ReplyView {...replyProps({ message: msg('m2', 'assistant', [{ type: 'thinking', key: 't', text: 'Weighing the weekend.' }], { state: 'streaming' }) })} />);
  expect(screen.queryByText('Thinking…')).toBeNull();
  const working = button('Working for 0 seconds');
  expect(working.textContent).toBe('Working for 0s');
  expect(working.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Weighing the weekend.')).toBeNull();
  fireEvent.click(working);
  expect(working.getAttribute('aria-expanded')).toBe('true');
  expect(window.getComputedStyle(screen.getByText('Weighing the weekend.')).color).toBe(theme.color.text2);
  view.rerender(<ReplyView {...replyProps({ message: msg('m2', 'assistant', [{ type: 'tools', key: 'b', steps: [running] }], { state: 'streaming' }) })} />);
  expect(screen.queryByText('Thinking…')).toBeNull();
  expect(screen.getByText('your sales for Dec 1 to Dec 31, 2025')).toBeTruthy();
  // No actions, versions or Based on line while it streams.
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
  expect(screen.queryByText(/^Based on/)).toBeNull();
});

describe('the Working for / Worked for timeline (owner request, 2026-11-17)', () => {
  const done: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: { ...SALES_STEP.input }, result: { ...SALES_STEP.result } };
  const thinking: MessagePart = { type: 'thinking', key: 't', text: 'Weighing the weekend.' };
  const steps = (...list: ToolStep[]): MessagePart => ({ type: 'tools', key: 'b', steps: list });
  const live = msg('m2', 'assistant', [thinking], { state: 'streaming', parentId: 'u1', startedAt: 0 });

  function region(toggle: HTMLElement): HTMLElement {
    const element = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (element === null) throw new Error('no region');
    return element;
  }

  it('starts closed on a new reply; opened while it streams, it stays open, as the same elements, as steps stream in and after it ends', () => {
    const workedOpen = workedOpenStore();
    const view = render(<ReplyView {...replyProps({ message: live, workedOpen })} />);
    const block = screen.getByTestId('worked');
    const toggle = screen.getByRole('button', { name: /^Working for \d+ seconds?$/ });
    const area = region(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(area.textContent).toBe('');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(area.textContent).toContain('Weighing the weekend.');
    const running: ToolStep = { ...done, state: 'running', result: null };
    view.rerender(<ReplyView {...replyProps({ message: { ...live, parts: [thinking, steps(running)] }, workedOpen })} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(area).getByText('Reading')).toBeTruthy();
    view.rerender(<ReplyView {...replyProps({ message: { ...live, parts: [thinking, steps(done)] }, workedOpen })} />);
    const row = within(area).getByText('your sales for Dec 1 to Dec 31, 2025');
    view.rerender(<ReplyView {...replyProps({
      message: { ...live, parts: [thinking, steps(done), text('c', 'Done.')], state: 'complete', nodeId: 'a1', endedAt: 12_000 }, workedOpen,
    })} />);
    // The same header, region and row: nothing was drawn anew when the reply ended.
    expect(screen.getByTestId('worked')).toBe(block);
    expect(button('Worked for 12 seconds')).toBe(toggle);
    expect(toggle.textContent).toBe('Worked for 12s');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region(toggle)).toBe(area);
    expect(within(area).getByText('your sales for Dec 1 to Dec 31, 2025')).toBe(row);
    // Closed, it says so, and opens again.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('a second prompt’s reply starts closed, while the first keeps the person’s choice', () => {
    const workedOpen = workedOpenStore();
    const firstReply = msg('m2', 'assistant', [thinking, text('c', 'Done.')], { nodeId: 'a1', parentId: 'u1', startedAt: 0, endedAt: 3000 });
    const view = render(<ReplyView {...replyProps({ message: firstReply, workedOpen })} />);
    fireEvent.click(button('Worked for 3 seconds'));
    view.rerender(
      <>
        <ReplyView {...replyProps({ message: firstReply, workedOpen, newest: false })} />
        <ReplyView {...replyProps({ message: { ...live, key: 'm4', parentId: null }, workedOpen })} />
      </>,
    );
    expect(button('Worked for 3 seconds').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^Working for/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('a reply drawn anew keeps the choice: by its key, by its node once saved, and by the node its turn named while it streamed', () => {
    const workedOpen = workedOpenStore();
    const turn: TuningChatState['turn'] = { kind: 'send', nodes: { user: 'u2', reply: 'a2', parentId: 'a1' }, earlier: null };
    const chat = fakeChat({}, { turn });
    const view = render(<ReplyView {...replyProps({ message: { ...live, key: 'm6' }, chat, workedOpen })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Working for/ }));
    view.unmount();
    // The same reply read again with a new key once its turn is saved (a reattached turn's reread).
    const saved = msg('m9', 'assistant', [thinking, text('c', 'Done.')], { nodeId: 'a2', parentId: 'u2', startedAt: 0, endedAt: 3000 });
    const again = render(<ReplyView {...replyProps({ message: saved, workedOpen })} />);
    expect(button('Worked for 3 seconds').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button('Worked for 3 seconds'));
    again.unmount();
    render(<ReplyView {...replyProps({ message: { ...saved, key: 'm12' }, workedOpen })} />);
    expect(button('Worked for 3 seconds').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens and closes the region’s height smoothly, keeping a closing timeline until it has folded and taking it out of reach at once', () => {
    jest.useFakeTimers();
    const view = render(<ReplyView {...replyProps({ message: live })} />);
    const toggle = screen.getByRole('button', { name: /^Working for/ });
    const area = region(toggle);
    expect(area.style.gridTemplateRows).toBe('0fr');
    expect(area.style.transition).toContain('grid-template-rows 200ms');
    fireEvent.click(toggle);
    expect(area.style.gridTemplateRows).toBe('1fr');
    const inner = area.firstElementChild as HTMLElement;
    // Clipped while it opens, then not, so a row's focus ring shows in full.
    expect(inner.style.overflow).toBe('hidden');
    act(() => { jest.advanceTimersByTime(COLLAPSE_MS); });
    expect(inner.style.overflow).toBe('visible');
    fireEvent.click(toggle);
    expect(area.style.gridTemplateRows).toBe('0fr');
    expect(inner.hasAttribute('inert')).toBe(true);
    expect(area.textContent).toContain('Weighing the weekend.');
    act(() => { jest.advanceTimersByTime(COLLAPSE_MS); });
    expect(area.textContent).toBe('');
    view.unmount();
  });

  it('under reduced motion opens and closes at once, with no transition', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true, writable: true,
      value: (query: string) => ({ media: query, matches: query === '(prefers-reduced-motion: reduce)', addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    try {
      render(<ReplyView {...replyProps({ message: live })} />);
      const toggle = screen.getByRole('button', { name: /^Working for/ });
      const area = region(toggle);
      expect(area.style.transition).toBe('none');
      fireEvent.click(toggle);
      expect((area.firstElementChild as HTMLElement).style.overflow).toBe('visible');
      fireEvent.click(toggle);
      expect(area.textContent).toBe('');
    } finally {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });
});

it('counts Working for {n}s once a second while it streams, and drops it when the reply ends', () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
  const streaming = msg('m2', 'assistant', [], { state: 'streaming', startedAt: Date.now() });
  const view = render(<ReplyView {...replyProps({ message: streaming })} />);
  expect(screen.getByText('Working for 0s')).toBeTruthy();
  act(() => { jest.advanceTimersByTime(3000); });
  expect(screen.getByText('Working for 3s')).toBeTruthy();
  view.rerender(<ReplyView {...replyProps({ message: { ...streaming, state: 'complete', endedAt: Date.now() }, })} />);
  expect(screen.queryByText(/^Working for/)).toBeNull();
  expect(screen.getByText('Worked for 3s')).toBeTruthy();
});

it('a settled reply’s Worked for {n}s is a collapsed button that opens to the thinking summary and the steps', () => {
  const step: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: { ...SALES_STEP.input }, result: { ...SALES_STEP.result } };
  const settled = msg('m2', 'assistant', [
    { type: 'thinking', key: 't', text: 'Weighing the weekend.' }, { type: 'tools', key: 'b', steps: [step] }, text('m2t', 'December was busy.'),
  ], { nodeId: 'a1', parentId: 'u1', startedAt: 1000, endedAt: 13_900 });
  const view = render(<ReplyView {...replyProps({ message: settled })} />);
  // Its name says seconds in full (a screen reader reads "12s" as "12 s"); it shows "12s".
  const worked = button('Worked for 12 seconds');
  expect(worked.textContent).toBe('Worked for 12s');
  expect(worked.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Weighing the weekend.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  expect(screen.queryByText('Read 1 thing')).toBeNull();
  // It sits above the reply's text.
  expect(before(worked, screen.getByText('December was busy.'))).toBe(true);
  fireEvent.click(worked);
  expect(worked.getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(worked.getAttribute('aria-controls') ?? '')?.contains(screen.getByText('Weighing the weekend.'))).toBe(true);
  expect(screen.getByRole('button', { name: 'Read your sales for Dec 1 to Dec 31, 2025. 31 days: guests on 31, net sales on 30' })).toBeTruthy();
  fireEvent.click(worked);
  expect(worked.getAttribute('aria-expanded')).toBe('false');
  view.rerender(<ReplyView {...replyProps({ message: { ...settled, endedAt: 2000 } })} />);
  expect(button('Worked for 1 second').textContent).toBe('Worked for 1s');
});

it('a settled reply with no steps or summary shows Worked for {n}s as plain text, and none when its time is unknown', () => {
  const plain = msg('m2', 'assistant', [text('m2t', 'Hi.')], { nodeId: 'a1', parentId: 'u1', startedAt: 0, endedAt: 4000 });
  const view = render(<ReplyView {...replyProps({ message: plain })} />);
  expect(screen.getByText('Worked for 4s')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Worked/ })).toBeNull();
  view.rerender(<ReplyView {...replyProps({ message: { ...plain, startedAt: null, endedAt: null } })} />);
  expect(screen.queryByText(/^Worked/)).toBeNull();
});

it('renders replies as Markdown and visuals in their streamed order', () => {
  const reply = msg('m2', 'assistant', [
    text('a', 'A **busy** weekend.'),
    { type: 'visual', key: 'b', id: 'v1', visual: daily },
    text('c', 'After the chart.'),
  ], { nodeId: 'a1', parentId: 'u1' });
  render(<ReplyView {...replyProps({ message: reply })} />);
  const bold = screen.getByText('busy');
  expect(bold.parentElement === null ? '' : window.getComputedStyle(bold.parentElement).fontWeight).toBe('700');
  expect(screen.queryByText(/\*\*/)).toBeNull();
  const title = first(screen.getAllByText(visualTitle(daily)));
  const after = screen.getByText('After the chart.');
  expect(before(bold, title)).toBe(true);
  expect(before(title, after)).toBe(true);
  // A complete reply: its actions, then the Based on line built from its tool calls.
  expect(before(after, button('Copy'))).toBe(true);
  expect(before(button('Not helpful'), screen.getByText('Based on this conversation only.'))).toBe(true);
  // No label box: the speaker is only named for assistive tech.
  expect(screen.queryByText('TownwiseAI')).toBeNull();
});

describe('charts and cards held until the reply ends (owner, 2026-11-18)', () => {
  const step: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: { ...SALES_STEP.input }, result: { ...SALES_STEP.result } };
  const card = { id: PROPOSAL_ID, proposal: PROPOSAL, status: 'open', stored: 'pending', edited: false, gone: false, error: null } as const;
  const parts: MessagePart[] = [
    { type: 'thinking', key: 'n', text: 'Let me check December.' },
    { type: 'tools', key: 't', steps: [step] },
    text('a', 'December was busy.'),
    { type: 'visual', key: 'v', id: 'v1', visual: daily },
    text('b', 'Here is a note for it.'),
    { type: 'proposal', key: 'p', card },
    text('c', 'Ask me about January next.'),
  ];
  const live = msg('m2', 'assistant', parts, { state: 'streaming', startedAt: 0 });
  const chartTitle = (): HTMLElement | null => screen.queryAllByText(visualTitle(daily))[0] ?? null;

  it('while the reply works, no chart or card renders: only its text, under the Working timeline', () => {
    render(<ReplyView {...replyProps({ message: live })} />);
    expect(chartTitle()).toBeNull();
    expect(screen.queryByText('Proposed note')).toBeNull();
    expect(document.querySelector('svg[role="img"], svg[aria-label]')).toBeNull();
    const working = screen.getByRole('button', { name: /^Working for/ });
    expect(before(working, screen.getByText('December was busy.'))).toBe(true);
    expect(screen.getByText('Ask me about January next.')).toBeTruthy();
  });

  it('once it ends with done they appear in the model’s order among the answer, any stop reason', () => {
    const view = render(<ReplyView {...replyProps({ message: live })} />);
    view.rerender(<ReplyView {...replyProps({ message: { ...live, state: 'complete', endedAt: 4000, note: 'Stopped at this month’s TownwiseAI budget.' } })} />);
    const title = chartTitle();
    if (title === null) throw new Error('no chart');
    const note = first(screen.getAllByText('Proposed note'));
    expect(before(screen.getByText('December was busy.'), title)).toBe(true);
    expect(before(title, screen.getByText('Here is a note for it.'))).toBe(true);
    expect(before(screen.getByText('Here is a note for it.'), note)).toBe(true);
    expect(before(note, screen.getByText('Ask me about January next.'))).toBe(true);
  });

  it('a stopped, failed or interrupted reply saved nothing and never shows them', () => {
    const view = render(<ReplyView {...replyProps({ message: live })} />);
    for (const state of ['stopped', 'failed'] as const) {
      view.rerender(<ReplyView {...replyProps({ message: { ...live, state, endedAt: 4000 } })} />);
      expect(chartTitle()).toBeNull();
      expect(screen.queryByText('Proposed note')).toBeNull();
      expect(screen.getByText('December was busy.')).toBeTruthy();
    }
  });

  it('a chart drawn twice with the same spec shows once, where it was drawn last; a different one still shows', () => {
    const twice = msg('m2', 'assistant', [
      { type: 'visual', key: 'v1', id: 'v1', visual: daily },
      text('a', 'Checking one more thing.'),
      { type: 'visual', key: 'v2', id: 'v2', visual: weekdays },
      text('b', 'December was busy.'),
      { type: 'visual', key: 'v3', id: 'v3', visual: JSON.parse(JSON.stringify(daily)) as typeof daily },
    ], { nodeId: 'a1', parentId: 'u1' });
    const once = render(<ReplyView {...replyProps({ message: { ...twice, parts: twice.parts.slice(0, 1) } })} />);
    const perChart = screen.getAllByText(visualTitle(daily)).length;
    once.unmount();
    render(<ReplyView {...replyProps({ message: twice })} />);
    const titles = screen.getAllByText(visualTitle(daily));
    expect(titles).toHaveLength(perChart);
    expect(before(screen.getByText('December was busy.'), first(titles))).toBe(true);
    expect(before(first(screen.getAllByText(visualTitle(weekdays))), screen.getByText('December was busy.'))).toBe(true);
  });

  it('a reply read back (a reload, or a reattach that reads the saved turn) reads exactly as the live one did once it ended', () => {
    const ended = { ...live, state: 'complete', endedAt: 4000 } as const;
    const view = render(<ReplyView {...replyProps({ message: live })} />);
    view.rerender(<ReplyView {...replyProps({ message: ended })} />);
    const streamed = view.container.textContent;
    view.unmount();
    const reloaded = render(<ReplyView {...replyProps({ message: ended })} />);
    expect(reloaded.container.textContent).toBe(streamed);
  });

  it('fades them in when the reply ends here, under reduced motion shows them at once, and a reply read back never fades', () => {
    const ended = { ...live, state: 'complete', endedAt: 4000 } as const;
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const view = render(<ReplyView {...replyProps({ message: live })} />);
      expect(timing).not.toHaveBeenCalled();
      view.rerender(<ReplyView {...replyProps({ message: ended })} />);
      // The chart and the card, each over the theme's fade.
      expect(timing.mock.calls.map(([, config]) => [config.toValue, config.duration])).toEqual([[1, theme.motion.fade], [1, theme.motion.fade]]);
      view.unmount();
      timing.mockClear();
      render(<ReplyView {...replyProps({ message: ended })} />);
      expect(timing).not.toHaveBeenCalled();
      cleanup();
      Object.defineProperty(window, 'matchMedia', {
        configurable: true, writable: true,
        value: (query: string) => ({ media: query, matches: query === '(prefers-reduced-motion: reduce)', addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      try {
        const reduced = render(<ReplyView {...replyProps({ message: live })} />);
        reduced.rerender(<ReplyView {...replyProps({ message: ended })} />);
        expect(chartTitle()).not.toBeNull();
        expect(timing).not.toHaveBeenCalled();
      } finally {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    } finally {
      timing.mockRestore();
    }
  });
});

/** A reply whose rating shows what the person pressed, as useTuningChat's optimistic rate does. */
function RatedReply(props: { rate: jest.Mock }): React.JSX.Element {
  const [message, setMessage] = useState(SAVED);
  const chat = fakeChat({
    rate: (key, rating, reason) => {
      props.rate(key, rating, reason);
      setMessage((current) => ({ ...current, feedback: rating === null ? null : { rating, reason: rating === 'down' ? reason ?? null : null } }));
    },
  });
  return <ReplyView {...replyProps({ message, chat })} />;
}

it('Helpful and Not helpful are a thumb up and a thumb down, named by their words, an outline until chosen and then filled in mint (owner, 2026-11-18)', () => {
  render(<RatedReply rate={jest.fn()} />);
  for (const name of ['Helpful', 'Not helpful']) {
    const control = button(name);
    expect(control.textContent).toBe('');
    expect(control.querySelector('svg')?.getAttribute('stroke')).toBe(theme.color.white);
    expect(control.querySelector('[data-testid="thumb-outline"]')?.getAttribute('fill') ?? null).toBeNull();
  }
  fireEvent.click(button('Helpful'));
  const chosen = button('Helpful');
  expect(chosen.querySelector('svg')?.getAttribute('stroke')).toBe(theme.color.mint);
  expect(chosen.querySelector('[data-testid="thumb-filled"]')?.getAttribute('fill')).toBe(theme.color.mint);
  // The hand is filled, not the box around it.
  expect(window.getComputedStyle(chosen).backgroundColor).not.toBe(MINT);
});

it('Helpful shows alone and pressed once chosen; pressing it again shows both; Not helpful asks the optional reason', () => {
  const rate = jest.fn();
  render(<RatedReply rate={rate} />);
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('false');
  expect(button('Not helpful').getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(button('Helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', 'up', undefined);
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('true');
  expect(button('Helpful').querySelector('[data-testid="thumb-filled"]')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Not helpful' })).toBeNull();

  fireEvent.click(button('Helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', null, undefined);
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('false');
  expect(button('Not helpful').getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(button('Not helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', 'down', undefined);
  expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
  const reasons = screen.getByRole('group', { name: 'What went wrong? Optional.' });
  // Named by the question it shows, so a screen reader reads it once on entering the group.
  expect(reasons.getAttribute('aria-label')).toBeNull();
  expect(reasons.getAttribute('aria-labelledby')).toBe(within(reasons).getByText('What went wrong? Optional.').id);
  expect(within(reasons).getAllByRole('button').map((item) => item.textContent)).toEqual([
    'Got my numbers wrong', 'Made something up', 'Missed something I told it', 'Didn’t answer my question', 'Too long', 'Something else', 'Skip',
  ]);
  fireEvent.click(within(reasons).getByRole('button', { name: 'Made something up' }));
  expect(rate).toHaveBeenLastCalledWith('m2', 'down', 'made_up');
  expect(screen.queryByRole('group', { name: 'What went wrong? Optional.' })).toBeNull();
  expect(button('Not helpful').getAttribute('aria-pressed')).toBe('true');
  // The reason went in, so focus goes back to the rating.
  expect(document.activeElement).toBe(button('Not helpful'));

  // Pressing it again clears it; Skip leaves Not helpful with no reason.
  fireEvent.click(button('Not helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', null, undefined);
  fireEvent.click(button('Not helpful'));
  const calls = rate.mock.calls.length;
  fireEvent.click(within(screen.getByRole('group', { name: 'What went wrong? Optional.' })).getByRole('button', { name: 'Skip' }));
  expect(rate).toHaveBeenCalledTimes(calls);
  expect(screen.queryByRole('group', { name: 'What went wrong? Optional.' })).toBeNull();
  expect(button('Not helpful').getAttribute('aria-pressed')).toBe('true');
});

it('shows why a rating didn’t save, on the reply', () => {
  render(<ReplyView {...replyProps({ message: { ...SAVED, ratingError: 'Couldn’t save your rating. Try again.' } })} />);
  expect(screen.getByText('Couldn’t save your rating. Try again.')).toBeTruthy();
});

it('offers Regenerate on the newest reply only, and Copy on web', async () => {
  jest.useFakeTimers();
  const chat = fakeChat();
  const older = msg('m2', 'assistant', [text('a', 'First part.'), text('b', 'Second part.')], { nodeId: 'a1', parentId: 'u1' });
  const newest = msg('m4', 'assistant', [text('c', 'Newest **reply**.')], { nodeId: 'a2', parentId: 'u2' });
  render(
    <>
      <ReplyView {...replyProps({ message: older, chat, newest: false })} />
      <ReplyView {...replyProps({ message: newest, chat })} />
    </>,
  );
  expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
  fireEvent.click(button('Regenerate'));
  expect(chat.regenerate).toHaveBeenCalledWith('m4');

  // Copy copies the reply's Markdown source, its text parts joined by a blank line.
  fireEvent.click(first(screen.getAllByRole('button', { name: 'Copy' })));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith('First part.\n\nSecond part.');
  expect(screen.getByText('Copied the reply.').closest('[aria-live="polite"]')).not.toBeNull();
  act(() => { jest.advanceTimersByTime(2000); });
  expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
  expect(screen.queryByText('Copied the reply.')).toBeNull();

  writeText.mockRejectedValueOnce(new Error('denied'));
  fireEvent.click(first(screen.getAllByRole('button', { name: 'Copy' })));
  expect(await screen.findByRole('button', { name: 'Couldn’t copy' })).toBeTruthy();
  expect(screen.queryByText('Copied the reply.')).toBeNull();
  act(() => { jest.advanceTimersByTime(2000); });
  expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
});

it('a copy that settles after the reply is gone starts no timer', async () => {
  jest.useFakeTimers();
  const view = render(<ReplyView {...replyProps()} />);
  fireEvent.click(button('Copy'));
  // A version switch draws every message anew, so the reply can go before the clipboard answers.
  view.unmount();
  const timeout = jest.spyOn(globalThis, 'setTimeout');
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledTimes(1);
  // No "Copied" timer for a button that is gone.
  expect(timeout.mock.calls.filter(([, ms]) => ms === 2000)).toHaveLength(0);
  timeout.mockRestore();
});

it('every action is aria-disabled while another reply streams and under view-as, and does nothing', () => {
  const chat = fakeChat();
  const view = render(<ReplyView {...replyProps({ chat, canAct: false })} />);
  for (const name of ['Copy', 'Regenerate', 'Helpful', 'Not helpful']) {
    expect(button(name).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button(name));
  }
  expect(chat.regenerate).not.toHaveBeenCalled();
  expect(chat.rate).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();

  // Under view-as the rating shows, pressed and inert, and each action names the read-only line.
  view.rerender(<ReplyView {...replyProps({ chat, readOnlyId: 'read-only', message: { ...SAVED, feedback: { rating: 'up', reason: null } } })} />);
  for (const name of ['Copy', 'Regenerate', 'Helpful']) {
    expect(button(name).getAttribute('aria-disabled')).toBe('true');
    expect(button(name).getAttribute('aria-describedby')).toBe('read-only');
    fireEvent.click(button(name));
  }
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('true');
  expect(chat.rate).not.toHaveBeenCalled();
  expect(chat.regenerate).not.toHaveBeenCalled();
});

it('once the month’s budget is used up, Regenerate, Edit and Try again are off; Copy and the ratings are not', () => {
  const chat = fakeChat({}, { budget: { month: '2026-11', usedUsd: 20, limitUsd: 20, exhausted: true } });
  const failed = msg('m4', 'assistant', [text('a', 'Half')], { state: 'stopped', note: 'Stopped. Your message and this reply weren’t saved.' });
  render(
    <>
      <UserMessage {...userProps({ chat })} />
      <ReplyView {...replyProps({ chat, newest: false })} />
      <ReplyView {...replyProps({ chat, message: { ...SAVED, key: 'm3', nodeId: 'a2' } })} />
      <ReplyView {...replyProps({ chat, message: failed })} />
    </>,
  );
  for (const name of ['Edit', 'Regenerate', 'Try again']) expect(button(name).getAttribute('aria-disabled')).toBe('true');
  for (const item of [...screen.getAllByRole('button', { name: 'Copy' }), ...screen.getAllByRole('button', { name: 'Helpful' })]) {
    expect(item.getAttribute('aria-disabled')).toBeNull();
  }
});

it('a failed or stopped reply keeps its note and Try again, as before', () => {
  const onRetry = jest.fn();
  const failed = msg('m2', 'assistant', [text('a', 'Half')], { state: 'failed', note: 'Your message and this reply weren’t saved.' });
  render(<ReplyView {...replyProps({ message: failed, onRetry })} />);
  expect(screen.getByText('Your message and this reply weren’t saved.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  fireEvent.click(button('Try again'));
  expect(onRetry).toHaveBeenCalledWith('m2');
});

it('edit moves focus into the field; Escape returns it to Edit; Save and send calls chat.edit', () => {
  const chat = fakeChat();
  const onEdited = jest.fn();
  render(<UserMessage {...userProps({ chat, onEdited })} />);
  fireEvent.click(button('Edit'));
  const field = screen.getByLabelText<HTMLTextAreaElement>('Edit your message');
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('How was December?');
  expect(field.getAttribute('maxlength')).toBe('4000');
  expect(screen.queryByTestId('user-bubble')).toBeNull();

  fireEvent.keyDown(field, { key: 'Escape' });
  expect(screen.queryByLabelText('Edit your message')).toBeNull();
  expect(document.activeElement).toBe(button('Edit'));
  expect(screen.getByText('How was December?')).toBeTruthy();

  // Cancel returns focus to Edit too.
  fireEvent.click(button('Edit'));
  fireEvent.click(button('Cancel'));
  expect(document.activeElement).toBe(button('Edit'));

  // A blank edit can't be sent.
  fireEvent.click(button('Edit'));
  fireEvent.change(screen.getByLabelText('Edit your message'), { target: { value: '   ' } });
  expect(button('Save and send').getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button('Save and send'));
  expect(chat.editMessage).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Edit your message'), { target: { value: 'How was last December?' } });
  fireEvent.click(button('Save and send'));
  expect(chat.editMessage).toHaveBeenCalledWith('m1', 'How was last December?');
  expect(onEdited).toHaveBeenCalledTimes(1);

  // Enter sends on web; Shift+Enter is a new line.
  fireEvent.keyDown(screen.getByLabelText('Edit your message'), { key: 'Enter', shiftKey: true });
  expect(chat.editMessage).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByLabelText('Edit your message'), { key: 'Enter' });
  expect(chat.editMessage).toHaveBeenCalledTimes(2);
});

it('Edit is aria-disabled while a reply streams and under view-as, and not on the page before the message is saved', () => {
  const chat = fakeChat();
  const view = render(<UserMessage {...userProps({ chat, busy: true })} />);
  expect(button('Edit').getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button('Edit'));
  expect(screen.queryByLabelText('Edit your message')).toBeNull();
  view.rerender(<UserMessage {...userProps({ chat, readOnlyId: 'read-only' })} />);
  expect(button('Edit').getAttribute('aria-disabled')).toBe('true');
  expect(button('Edit').getAttribute('aria-describedby')).toBe('read-only');
  view.rerender(<UserMessage {...userProps({ chat, message: { ...ASKED, nodeId: null } })} />);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('an unsaved message keeps its row’s place, hidden and with nothing to reach, and the same row fills in once saved', () => {
  const chat = fakeChat();
  const view = render(<UserMessage {...userProps({ chat, message: { ...ASKED, nodeId: null, at: Date.now() } })} />);
  const pending = screen.getByTestId('user-actions');
  expect(pending.getAttribute('aria-hidden')).toBe('true');
  expect(pending.getAttribute('data-actions')).toBe('always');
  // The filled row's height (its 44px controls), so the reply under it does not move when the row fills in.
  expect(window.getComputedStyle(pending).height).toBe('44px');
  expect(pending.querySelector('button, [role="button"], [tabindex]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();

  view.rerender(<UserMessage {...userProps({ chat, message: { ...ASKED, at: Date.now() } })} />);
  const saved = screen.getByTestId('user-actions');
  expect(saved.getAttribute('aria-hidden')).toBeNull();
  expect(saved.getAttribute('data-actions')).toBe('always');
  expect(within(saved).getByRole('button', { name: 'Edit' })).toBeTruthy();
  expect(within(saved).getByRole('button', { name: 'Copy' })).toBeTruthy();
  // The same row in the same place: one flex row, its items at the end.
  expect(window.getComputedStyle(saved).flexDirection).toBe(window.getComputedStyle(pending).flexDirection);
  expect(window.getComputedStyle(saved).justifyContent).toBe('flex-end');
});

describe('links to the team’s own data (spec P25 build note, 2026-11-18)', () => {
  const UPLOAD = 'u_0123456789abcdef01234567';
  const sales: ToolStep = {
    id: 's1', name: 'get_sales_days', state: 'done', input: { from: '2026-01-01', to: '2026-04-01' },
    result: { from: '2026-01-01', to: '2026-04-01', dayCount: 91, guestsDayCount: 91, netSalesDayCount: 91, uploadRefs: [UPLOAD] },
  };
  const day: ToolStep = {
    id: 'd1', name: 'get_day', state: 'done', input: { date: '2026-05-30' },
    result: { date: '2026-05-30', hasSales: true, closed: false, noteCount: 0, eventCount: 1, sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/events' }] },
  };
  const town: ToolStep = {
    id: 't1', name: 'get_town_calendar', state: 'done', input: { from: '2026-05-30', to: '2026-05-30' },
    result: { eventCount: 1, sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/events' }] },
  };
  const reply = (steps: ToolStep[], words = 'Saturday, May 30, 2026 was your best day.') =>
    msg('m2', 'assistant', [{ type: 'tools', key: 'k', steps }, text('m2t', words)], { nodeId: 'a1', parentId: 'u1' });

  function link(name: string): HTMLElement {
    return screen.getByRole('link', { name });
  }

  function press(name: RegExp): void {
    fireEvent.click(screen.getByRole('button', { name }));
  }

  it('a step and its Based on piece link to the Calendar’s day and the Your data upload; the town calendar keeps its source chips', () => {
    render(<ReplyView {...replyProps({ message: reply([sales, day, town]), me: meOf(ACCESS.member) })} />);
    const basedOn = screen.getByText(/^Based on/);
    expect(basedOn.textContent).toBe('Based on your sales from Jan 1 to Apr 1, 2026, what Townwise has for Sat, May 30, 2026, and Hanover’s calendar for May 30, 2026.');
    expect(within(basedOn).getByRole('link', { name: 'your sales from Jan 1 to Apr 1, 2026' }).getAttribute('href')).toBe(`/locations/l1/data/${UPLOAD}`);
    expect(within(basedOn).getByRole('link', { name: 'what Townwise has for Sat, May 30, 2026' }).getAttribute('href')).toBe('/locations/l1/calendar?day=2026-05-30');
    expect(within(basedOn).getAllByRole('link')).toHaveLength(2);

    press(/^Worked/);
    expect(link('Open the upload with these sales on Your data').getAttribute('href')).toBe(`/locations/l1/data/${UPLOAD}`);
    expect(link('Open Sat, May 30, 2026 in Calendar').getAttribute('href')).toBe('/locations/l1/calendar?day=2026-05-30');
    expect(link('Open Sat, May 30, 2026 in Calendar').textContent).toBe('Open in Calendar');
    // The step's words stay the button that opens what it read; the town calendar's step has no data link.
    expect(screen.getByRole('button', { name: /^Read your sales for Jan 1 to Apr 1, 2026/ })).toBeTruthy();
    press(/^Read Hanover’s calendar/);
    expect(screen.getAllByRole('link').filter((element) => element.getAttribute('href')?.startsWith('/'))).toHaveLength(4);
    expect(screen.getAllByRole('link', { name: /Dartmouth|dartmouth/ }).length).toBeGreaterThan(0);
  });

  // An independent browser review, 2026-11-18: a blank line sat above each step's link, and the focus box of a wrapped
  // Based on link covered the lines beside it.
  it('a step’s link sits right under its words; each link’s focus ring keeps to its words, and the Based on line leaves it room', () => {
    render(<><PortalStyles /><ReplyView {...replyProps({ message: reply([sales, day, town]), me: meOf(ACCESS.member) })} /></>);
    const css = Array.from(document.querySelectorAll('style')).map((sheet) => sheet.textContent).join('\n');
    // The ring 2px outside the words on every side: 13px of side padding while focused, given back by a -13px margin,
    // and each line of a wrapped link ringed on its own (independent UI review, 2026-11-18).
    expect(css).toContain('#tw-portal [data-ring="text"]:focus-visible{outline-offset:-11px;padding-left:13px;padding-right:13px;margin-left:-13px;margin-right:-13px;-webkit-box-decoration-break:clone;box-decoration-break:clone}');
    const basedOn = screen.getByText(/^Based on/);
    // jsdom computes no line-height, so it is read from react-native-web's rule for the line's class.
    const lineClass = Array.from(basedOn.classList).find((name) => name.startsWith('r-lineHeight-'));
    const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
    const lineRule = rules.find((rule) => rule instanceof CSSStyleRule && lineClass !== undefined && rule.selectorText.includes(lineClass));
    expect(lineRule instanceof CSSStyleRule ? lineRule.style.getPropertyValue('line-height') : null).toBe('24px');
    for (const element of within(basedOn).getAllByRole('link')) {
      expect(element.getAttribute('data-ring')).toBe('text');
      expect(window.getComputedStyle(element).paddingTop).toBe('13px');
    }
    press(/^Worked/);
    const open = link('Open Sat, May 30, 2026 in Calendar');
    expect(open.getAttribute('data-ring')).toBe('text');
    // Its 46px target (13 above and below its 20px line) is pulled up over the row's gap and its own padding, so its
    // words sit under the step's as the next line would.
    expect([window.getComputedStyle(open).paddingTop, window.getComputedStyle(open).paddingBottom]).toEqual(['13px', '13px']);
    expect(window.getComputedStyle(open.parentElement ?? open).marginTop).toBe('-21px');
    expect(window.getComputedStyle(open.parentElement ?? open).minHeight).not.toBe('44px');
  });

  it('several uploads behind a range, or the summary, open Your data’s list', () => {
    const several = { ...sales, result: { ...sales.result, uploadRefs: [UPLOAD, 'u_89abcdef0123456789abcdef'] } };
    const overview: ToolStep = {
      id: 'o1', name: 'get_location_overview', state: 'done', input: null,
      result: { firstDate: '2025-05-01', lastDate: '2026-11-17', dayCount: 553, missingDays: 0, monthCount: 19 },
    };
    render(<ReplyView {...replyProps({ message: reply([several, overview]), me: meOf(ACCESS.member) })} />);
    const basedOn = screen.getByText(/^Based on/);
    for (const element of within(basedOn).getAllByRole('link')) expect(element.getAttribute('href')).toBe('/locations/l1/data');
    press(/^Worked/);
    expect(screen.getAllByRole('link', { name: 'Open Your data' })).toHaveLength(2);
  });

  it('plain text when the person may not open the page, and without GET /api/me; never a link from the reply’s text', () => {
    const view = render(<ReplyView {...replyProps({ message: reply([sales, day]), me: meOf(ACCESS.pending) })} />);
    const words = 'Based on your sales from Jan 1 to Apr 1, 2026 and what Townwise has for Sat, May 30, 2026.';
    expect(screen.getByText(words)).toBeTruthy();
    press(/^Worked/);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    view.rerender(<ReplyView {...replyProps({ message: reply([sales, day]) })} />);
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    // View-as reads both pages, so the links stay.
    view.rerender(<ReplyView {...replyProps({ message: reply([sales, day]), me: viewAsMe(ACCESS.member) })} />);
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    // A reply that names a day and its sales in words, with no read behind them, links nothing.
    view.rerender(<ReplyView {...replyProps({ message: reply([], 'Your sales from Jan 1 to Apr 1, 2026 and Sat, May 30, 2026 were strong.'), me: meOf(ACCESS.member) })} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('Based on this conversation only.')).toBeTruthy();
  });
});

const VERSIONS: TreeNode[] = [
  { id: 'u1', parentId: null, role: 'user' },
  { id: 'u1b', parentId: null, role: 'user' },
  { id: 'a1', parentId: 'u1', role: 'assistant' },
  { id: 'a1b', parentId: 'u1', role: 'assistant' },
  { id: 'a1c', parentId: 'u1', role: 'assistant' },
];

it('the version navigator reads Version 2 of 3, steps both ways and is aria-disabled at its ends and while streaming', () => {
  const chat = fakeChat({}, { tree: VERSIONS });
  const second = { ...SAVED, nodeId: 'a1b' };
  const view = render(<ReplyView {...replyProps({ chat, tree: VERSIONS, message: second })} />);
  const nav = screen.getByRole('group', { name: 'Versions' });
  expect(within(nav).getByText('Version 2 of 3')).toBeTruthy();
  expect(within(nav).getByText('2/3').getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(within(nav).getByRole('button', { name: 'Previous version' }));
  expect(chat.showVersion).toHaveBeenLastCalledWith('m2', -1);
  fireEvent.click(within(nav).getByRole('button', { name: 'Next version' }));
  expect(chat.showVersion).toHaveBeenLastCalledWith('m2', 1);

  view.rerender(<ReplyView {...replyProps({ chat, tree: VERSIONS, message: { ...SAVED, nodeId: 'a1' } })} />);
  expect(button('Previous version').getAttribute('aria-disabled')).toBe('true');
  expect(button('Next version').getAttribute('aria-disabled')).toBeNull();
  view.rerender(<ReplyView {...replyProps({ chat, tree: VERSIONS, message: { ...SAVED, nodeId: 'a1c' } })} />);
  expect(screen.getByText('Version 3 of 3')).toBeTruthy();
  expect(button('Next version').getAttribute('aria-disabled')).toBe('true');
  const calls = (chat.showVersion as jest.Mock).mock.calls.length;
  fireEvent.click(button('Next version'));
  // While a reply streams both ends are off, still in the tab order.
  view.rerender(<ReplyView {...replyProps({ chat, tree: VERSIONS, canAct: false, message: second })} />);
  for (const name of ['Previous version', 'Next version']) {
    expect(button(name).getAttribute('aria-disabled')).toBe('true');
    expect(button(name).getAttribute('tabindex')).toBe('0');
    fireEvent.click(button(name));
  }
  expect(chat.showVersion).toHaveBeenCalledTimes(calls);

  // The person's message has its own navigator; a node with no siblings has none.
  view.rerender(
    <>
      <UserMessage {...userProps({ chat, tree: VERSIONS, message: { ...ASKED, nodeId: 'u1b' }, busy: true })} />
      <ReplyView {...replyProps({ chat, tree: TREE, message: SAVED })} />
    </>,
  );
  expect(screen.getAllByRole('group', { name: 'Versions' })).toHaveLength(1);
  expect(screen.getByText('Version 2 of 2')).toBeTruthy();
  expect(button('Previous version').getAttribute('aria-disabled')).toBe('true');
});

/** Three versions of the reply only, so the thread has one navigator. */
const REPLIES = VERSIONS.filter((node) => node.id !== 'u1b');

/** The thread's messages, keyed as the page keys them, so a path read again draws every message anew. */
function Messages(props: { messages: readonly ChatMessage[]; chat: TuningChat; busy: boolean; onAnnounce: (words: string) => void }): React.JSX.Element {
  const { chat, busy, onAnnounce } = props;
  return (
    <>
      {props.messages.map((message) => (message.role === 'user'
        ? <UserMessage key={message.key} {...userProps({ chat, message, tree: REPLIES, busy, onAnnounce })} />
        : <ReplyView key={message.key} {...replyProps({ chat, message, tree: REPLIES, canAct: !busy, onAnnounce })} />))}
    </>
  );
}

/**
 * A thread whose version switch reads the other version as useTuningChat does: every message comes back new. Like the
 * page, it has one polite region outside the messages, and a composer field.
 */
function SwitchingThread(): React.JSX.Element {
  const [shown, setShown] = useState({ messages: [ASKED, { ...SAVED, nodeId: 'a1b' }], switching: false });
  const [said, setSaid] = useState('');
  const chat = fakeChat({
    showVersion: (_key, step) => {
      setShown((current) => ({ ...current, switching: true }));
      void Promise.resolve().then(() => {
        setShown({ switching: false, messages: [{ ...ASKED, key: 'm5' }, { ...SAVED, key: 'm6', nodeId: step === 1 ? 'a1c' : 'a1' }] });
      });
    },
  }, { tree: REPLIES, switching: shown.switching });
  return (
    <>
      <Messages messages={shown.messages} chat={chat} busy={shown.switching} onAnnounce={setSaid} />
      <textarea aria-label="Message TownwiseAI" />
      <div data-testid="page-region" aria-live="polite">{said}</div>
    </>
  );
}

it('a version switch keeps focus on the pressed arrow and says which version shows', async () => {
  render(<SwitchingThread />);
  const region = screen.getByTestId('page-region');
  const next = button('Next version');
  act(() => { next.focus(); });
  fireEvent.click(next);
  // The words go to the page's region, there since before the switch, never to one drawn with the new navigator.
  expect(await screen.findByText('Showing version 3 of 3.')).toBe(region);
  expect(screen.getByText('Version 3 of 3')).toBeTruthy();
  expect(document.activeElement).toBe(button('Next version'));
  expect(document.activeElement).not.toBe(next);
  expect(screen.getByRole('group', { name: 'Versions' }).querySelector('[aria-live]')).toBeNull();
});

it('a version switch leaves focus where the person moved it while the version loaded', async () => {
  render(<SwitchingThread />);
  const next = button('Next version');
  act(() => { next.focus(); });
  fireEvent.click(next);
  const composer = screen.getByLabelText('Message TownwiseAI');
  act(() => { composer.focus(); });
  // Said after the navigator would have taken focus, so focus is checked once the words are in.
  expect(await screen.findByText('Showing version 3 of 3.')).toBe(screen.getByTestId('page-region'));
  expect(screen.getByText('Version 3 of 3')).toBeTruthy();
  expect(document.activeElement).toBe(composer);
});

it('a switch cut short by opening another conversation leaves nothing to take focus later', async () => {
  const onAnnounce = jest.fn();
  const shown = [ASKED, { ...SAVED, nodeId: 'a1b' }];
  const thread = (conversationId: string, messages: readonly ChatMessage[], switching: boolean): React.JSX.Element => (
    <Messages messages={messages} chat={fakeChat({}, { conversationId, tree: REPLIES, switching })} busy={switching} onAnnounce={onAnnounce} />
  );
  const view = render(thread('c1', shown, false));
  const next = button('Next version');
  act(() => { next.focus(); });
  fireEvent.click(next);
  view.rerender(thread('c1', shown, true));
  // Another conversation opens before the version arrives, so the thread empties and that switch's answer is dropped.
  view.rerender(thread('c2', [], false));
  await act(async () => { await Promise.resolve(); });
  // Back in the first conversation later, its navigator neither takes focus nor says anything.
  view.rerender(thread('c1', [{ ...ASKED, key: 'm9' }, { ...SAVED, key: 'm10', nodeId: 'a1c' }], false));
  expect(screen.getByText('Version 3 of 3')).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
  expect(onAnnounce).not.toHaveBeenCalled();
});

/** A newest reply that regenerates: the stream replaces it, then the turn is saved as its second version. */
function RegeneratingThread(props: { composer?: boolean }): React.JSX.Element {
  const [shown, setShown] = useState<{ reply: ChatMessage; tree: TreeNode[]; turn: TuningChatState['turn'] }>({ reply: SAVED, tree: TREE, turn: null });
  const chat = fakeChat({
    regenerate: () => {
      setShown({
        reply: msg('m7', 'assistant', [], { state: 'streaming', parentId: 'u1' }), tree: TREE,
        turn: { kind: 'regenerate', nodes: null, earlier: null },
      });
      setTimeout(() => {
        setShown({
          reply: msg('m7', 'assistant', [text('x', 'A second answer.')], { nodeId: 'a1b', parentId: 'u1' }),
          tree: [...TREE, { id: 'a1b', parentId: 'u1', role: 'assistant' }], turn: null,
        });
      }, 10);
    },
  }, { tree: shown.tree, turn: shown.turn });
  return (
    <>
      <UserMessage {...userProps({ chat, tree: shown.tree })} />
      <ReplyView {...replyProps({ chat, tree: shown.tree, message: shown.reply, canAct: shown.turn === null })} />
      {props.composer === true ? <textarea aria-label="Message TownwiseAI" /> : null}
    </>
  );
}

it('Regenerate moves focus to the new reply’s version navigator once it is saved', async () => {
  render(<RegeneratingThread />);
  const regenerate = button('Regenerate');
  act(() => { regenerate.focus(); });
  fireEvent.click(regenerate);
  expect(screen.getByText(/^Working for \d+s$/)).toBeTruthy();
  expect(await screen.findByText('Version 2 of 2')).toBeTruthy();
  expect(document.activeElement).toBe(button('Previous version'));
});

it('Regenerate leaves focus in the composer when the person went there while the reply streamed', async () => {
  render(<RegeneratingThread composer />);
  const regenerate = button('Regenerate');
  act(() => { regenerate.focus(); });
  fireEvent.click(regenerate);
  // Typing the next question during the stream (Stop and send is a supported flow).
  const composer = screen.getByLabelText('Message TownwiseAI');
  act(() => { composer.focus(); });
  expect(await screen.findByText('Version 2 of 2')).toBeTruthy();
  expect(document.activeElement).toBe(composer);
});

it('long words wrap inside the bubble and the reply', () => {
  const long = 'x'.repeat(300);
  render(
    <>
      <UserMessage {...userProps({ message: msg('m1', 'user', [text('a', long)], { nodeId: 'u1' }) })} />
      <ReplyView {...replyProps({ message: msg('m2', 'assistant', [text('b', `y${long}`)], { nodeId: 'a1', parentId: 'u1' }) })} />
    </>,
  );
  expect(screen.getByText(long).style.overflowWrap).toBe('anywhere');
  expect(screen.getByText(`y${long}`).parentElement?.style.overflowWrap).toBe('anywhere');
});

it('the bubble is a rounded panel, right-aligned, at most 70% wide from 641px and 85% on phones', () => {
  render(<UserMessage {...userProps()} />);
  const bubble = screen.getByTestId('user-bubble');
  const style = window.getComputedStyle(bubble);
  expect(style.borderTopLeftRadius).toBe('16px');
  expect(style.backgroundColor).toBe(theme.color.panel);
  expect(style.borderTopColor).toBe(theme.color.border);
  expect(bubble.style.maxWidth).toBe('70%');
  setWidth(360);
  expect(screen.getByTestId('user-bubble').style.maxWidth).toBe('85%');
});

it('each message starts with a hidden speaker label', () => {
  render(
    <>
      <UserMessage {...userProps()} />
      <ReplyView {...replyProps()} />
    </>,
  );
  for (const [label, words] of [['You said', 'How was December?'], ['TownwiseAI said', 'December was busy.']] as const) {
    const speaker = screen.getByText(label);
    const style = window.getComputedStyle(speaker);
    expect(style.position).toBe('absolute');
    expect(style.width).toBe('1px');
    expect(style.height).toBe('1px');
    expect(before(speaker, screen.getByText(words))).toBe(true);
  }
});

it('next chips are a named group of three that send on press and are disabled under view-as', () => {
  const onAsk = jest.fn();
  const prompts = ['Show that as a chart', 'How did last week go?', 'What notes do I have?'];
  const view = render(<NextChips prompts={prompts} disabled={false} readOnlyId={null} onAsk={onAsk} />);
  const group = screen.getByRole('group', { name: 'Suggested next questions' });
  const chips = within(group).getAllByRole('button');
  expect(chips.map((chip) => chip.textContent)).toEqual(prompts);
  expect(window.getComputedStyle(first(chips)).borderTopLeftRadius).toBe('22px');
  fireEvent.click(button('How did last week go?'));
  expect(onAsk).toHaveBeenCalledWith('How did last week go?');

  view.rerender(<NextChips prompts={prompts} disabled={false} readOnlyId="read-only" onAsk={onAsk} />);
  for (const chip of within(screen.getByRole('group', { name: 'Suggested next questions' })).getAllByRole('button')) {
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.getAttribute('aria-describedby')).toBe('read-only');
    fireEvent.click(chip);
  }
  view.rerender(<NextChips prompts={prompts} disabled readOnlyId={null} onAsk={onAsk} />);
  fireEvent.click(button('Show that as a chart'));
  expect(button('Show that as a chart').getAttribute('aria-disabled')).toBe('true');
  expect(onAsk).toHaveBeenCalledTimes(1);
});

it('next chips draw three chips when the model repeats a prompt', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const view = render(<NextChips prompts={['How did last week go?', 'How did last week go?', 'What notes do I have?']} disabled={false} readOnlyId={null} onAsk={jest.fn()} />);
    view.rerender(<NextChips prompts={['What notes do I have?', 'How did last week go?', 'How did last week go?']} disabled={false} readOnlyId={null} onAsk={jest.fn()} />);
    const chips = within(screen.getByRole('group', { name: 'Suggested next questions' })).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['What notes do I have?', 'How did last week go?', 'How did last week go?']);
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it('the actions are icon buttons: an svg and no visible text, with the same names', () => {
  render(<ReplyView {...replyProps()} />);
  for (const name of ['Copy', 'Helpful', 'Not helpful']) {
    const control = button(name);
    expect(control.textContent).toBe('');
    expect(control.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  }
  cleanup();
  render(<ReplyView {...replyProps({ message: { ...SAVED, parentId: 'u1' } })} />);
  expect(button('Regenerate').textContent).toBe('');
  expect(button('Regenerate').querySelector('svg')).not.toBeNull();
});

it('Copy shows a check while it reads Copied', async () => {
  render(<ReplyView {...replyProps()} />);
  const before = button('Copy').querySelector('svg')?.innerHTML;
  fireEvent.click(button('Copy'));
  const copied = await screen.findByRole('button', { name: 'Copied' });
  expect(copied.querySelector('svg')?.innerHTML).not.toBe(before);
  expect(copied.querySelector('path')?.getAttribute('d')).toBe('M20 6 9 17l-5-5');
});

it('a reply’s row ends with its time: the clock today, the day on another day, none when unknown', () => {
  const today = new Date(); today.setHours(20, 59, 0, 0);
  const view = render(<ReplyView {...replyProps({ message: { ...SAVED, at: today.getTime() } })} />);
  expect(screen.getByText('8:59 PM')).toBeTruthy();
  const old = new Date(2020, 10, 9, 8, 5).getTime();
  view.rerender(<ReplyView {...replyProps({ message: { ...SAVED, at: old } })} />);
  expect(screen.getByText('Nov 9, 2020, 8:05 AM')).toBeTruthy();
  view.rerender(<ReplyView {...replyProps({ message: { ...SAVED, at: null } })} />);
  expect(document.querySelector('[data-actions]')?.textContent).toBe('');
  view.rerender(<ReplyView {...replyProps({ message: { ...SAVED, at: old, state: 'streaming' } })} />);
  expect(screen.queryByText('Nov 9, 2020, 8:05 AM')).toBeNull();
});

it('the person’s row is the time, Edit and Copy icons; Copy copies the message', async () => {
  const old = new Date(2020, 10, 9, 8, 5).getTime();
  render(<UserMessage {...userProps({ message: { ...ASKED, at: old } })} />);
  const edit = button('Edit');
  expect(edit.textContent).toBe('');
  expect(edit.querySelector('svg')).not.toBeNull();
  const time = screen.getByText('Nov 9, 2020, 8:05 AM');
  expect(before(time, edit)).toBe(true);
  expect(before(edit, button('Copy'))).toBe(true);
  fireEvent.click(button('Copy'));
  expect(writeText).toHaveBeenCalledWith('How was December?');
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
});

it('each message is marked data-msg and its row data-actions always or hover; the rows hide with opacity only', () => {
  const { container } = render(
    <>
      <PortalStyles />
      <div id="tw-portal">
        <UserMessage {...userProps({ actions: 'hover' })} />
        <ReplyView {...replyProps({ actions: 'always' })} />
      </div>
    </>,
  );
  expect(container.querySelectorAll('[data-msg]')).toHaveLength(2);
  expect([...container.querySelectorAll('[data-actions]')].map((row) => row.getAttribute('data-actions'))).toEqual(['hover', 'always']);
  const css = [...document.querySelectorAll('style')].map((element) => element.textContent).find((text) => text.includes('data-actions')) ?? '';
  expect(css).toContain('#tw-portal [data-actions="hover"]{opacity:0}');
  expect(css).toContain('#tw-portal [data-msg]:hover [data-actions="hover"]');
  expect(css).toContain('#tw-portal [data-msg]:focus-within [data-actions="hover"]');
  expect(css).toContain('@media (hover:none){#tw-portal [data-actions="hover"]{opacity:1}}');
  expect(css).not.toContain('display:none');
  // Hidden rows stay in the tab order: the controls are still there.
  cleanup();
  render(<UserMessage {...userProps({ actions: 'hover' })} />);
  expect(button('Edit')).toBeTruthy();
});

// D37: a reply's web searches. Synthetic pages; the card's and the sources' shapes as api/src/chat/web-search.ts sends them.
const SEARCHED: ToolStep = {
  id: 'srvtoolu_01', name: 'web_search', state: 'done', input: null,
  result: { pages: 9, sources: [{ host: 'www.example.com', url: 'https://www.example.com/fair' }, { host: 'example.org', url: 'https://example.org/road' }] },
};
const CITED = [
  { host: 'www.example.com', url: 'https://www.example.com/fair' }, { host: 'example.org', url: 'https://example.org/road?day=2' },
  { host: 'home.dartmouth.edu', url: 'https://home.dartmouth.edu/events' },
];

it('shows a reply’s sources under its Based on line (D37) as source chips (D40) in a group named Sources, each opening in a new tab', () => {
  const reply = msg('m2', 'assistant', [{ type: 'tools', key: 'b', steps: [SEARCHED] }, text('c', 'The fair is on Saturday.')], {
    nodeId: 'a1', parentId: 'u1', sources: CITED,
  });
  const view = render(<ReplyView {...replyProps({ message: reply })} />);
  const group = screen.getByRole('group', { name: 'Sources' });
  expect(screen.getByText('Sources')).toBeTruthy();
  const links = within(group).getAllByRole('link');
  // Each chip shows its site's name, or for a site the manifest lacks the host without www.; the link goes to the URL
  // as the server sent it, in a new tab, and its title is that URL.
  expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel'), link.getAttribute('title')])).toEqual([
    ['example.com', 'https://www.example.com/fair', '_blank', 'noopener noreferrer', 'https://www.example.com/fair'],
    ['example.org', 'https://example.org/road?day=2', '_blank', 'noopener noreferrer', 'https://example.org/road?day=2'],
    ['Dartmouth', 'https://home.dartmouth.edu/events', '_blank', 'noopener noreferrer', 'https://home.dartmouth.edu/events'],
  ]);
  expect(screen.getByRole('link', { name: 'example.org. Source' })).toBe(links[1]);
  expect(screen.getByRole('link', { name: 'Dartmouth. Source' })).toBe(links[2]);
  // A site the manifest lacks shows the globe, a drawing; a known one its committed logo instead (jest's asset stub draws
  // no image, test/portal/ui/source-chip.test.web.tsx checks the logo itself).
  expect(links.map((link) => link.querySelector('[aria-hidden="true"] svg') !== null)).toEqual([true, true, false]);
  const basedOn = screen.getByText('Based on public web pages.');
  expect(before(basedOn, group)).toBe(true);
  // No sources, no group; a reply that is streaming, failed or stopped shows none.
  view.rerender(<ReplyView {...replyProps({ message: { ...reply, sources: [] } })} />);
  expect(screen.queryByRole('group', { name: 'Sources' })).toBeNull();
  expect(screen.queryByText('Sources')).toBeNull();
  for (const state of ['streaming', 'failed', 'stopped'] as const) {
    view.rerender(<ReplyView {...replyProps({ message: { ...reply, state } })} />);
    expect(screen.queryByRole('group', { name: 'Sources' })).toBeNull();
  }
});

it('a web search card reads Searching the web while the reply streams, and once it ended, what it found or that it never finished (D37)', () => {
  const searching: ToolStep = { id: 'srvtoolu_02', name: 'web_search', state: 'running', input: null, result: null };
  const live = msg('m2', 'assistant', [{ type: 'tools', key: 'b', steps: [SEARCHED, searching] }], { state: 'streaming' });
  const view = render(<ReplyView {...replyProps({ message: live })} />);
  // Opened while it streams, it stays open once the reply ends.
  fireEvent.click(screen.getByRole('button', { name: /^Working for/ }));
  expect(screen.getByText('Searching')).toBeTruthy();
  expect(screen.getByText('Searched')).toBeTruthy();
  expect(screen.getAllByText('the web')).toHaveLength(2);
  // A card has no query to show and nothing to open.
  expect(screen.getByText('9 pages: example.com, example.org')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Searched the web/ })).toBeNull();
  for (const state of ['complete', 'stopped', 'failed'] as const) {
    view.rerender(<ReplyView {...replyProps({ message: { ...live, state, parts: [...live.parts, text('c', 'Done.')] } })} />);
    expect(button('Worked').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.getByText('before the search finished')).toBeTruthy();
    expect(screen.queryByText('Searching')).toBeNull();
    expect(screen.getByText('9 pages: example.com, example.org')).toBeTruthy();
  }
  const failed: ToolStep = { ...searching, state: 'error', result: { code: 'max_uses_exceeded' } };
  view.rerender(<ReplyView {...replyProps({ message: { ...live, state: 'complete', parts: [{ type: 'tools', key: 'b', steps: [failed] }, text('c', 'Done.')] } })} />);
  expect(screen.getByText('Couldn’t search')).toBeTruthy();
  expect(screen.queryByText(/max_uses_exceeded/)).toBeNull();
  expect(screen.getByText('Based on this conversation only.')).toBeTruthy();
});
