import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { ToolContext, ToolStep } from '../../src/chat/tools';
import type { TreeNode } from '../../src/chat/tree';
import { initialChatState, type ChatMessage, type MessagePart, type TuningChat, type TuningChatState } from '../../src/chat/useTuningChat';
import { NextChips } from '../../src/chat/ui/NextChips';
import { ReplyView } from '../../src/chat/ui/ReplyView';
import { UserMessage } from '../../src/chat/ui/UserMessage';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { visualTitle } from '../../src/chat/visuals/words';
import { SALES_STEP } from '../helpers/chat';
import { daily } from './visuals-fixtures';

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
const MINT = 'rgb(123, 210, 180)';

function fakeChat(over: Partial<TuningChat> = {}, state: Partial<TuningChatState> = {}): TuningChat {
  return {
    state: {
      ...initialChatState(), status: 'ready', enabled: true, conversationId: 'c1',
      budget: { month: '2026-11', usedUsd: 1, limitUsd: 20, exhausted: false }, ...state,
    },
    setDraft: jest.fn(), send: jest.fn(), ask: jest.fn(), stop: jest.fn(), stopAndSend: jest.fn(), newConversation: jest.fn(),
    openConversation: jest.fn(), deleteConversation: jest.fn(() => Promise.resolve()), rename: jest.fn(() => Promise.resolve()),
    save: jest.fn(), saveEdited: jest.fn(() => Promise.resolve()), edit: jest.fn(), cancelEdit: jest.fn(), dismiss: jest.fn(),
    reopen: jest.fn(), editMessage: jest.fn(), regenerate: jest.fn(), showVersion: jest.fn(), rate: jest.fn(), retry: jest.fn(),
    reload: jest.fn(), ...over,
  };
}

function text(key: string, value: string): MessagePart {
  return { type: 'text', key, text: value };
}

function msg(key: string, role: ChatMessage['role'], parts: MessagePart[], over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    key, role, parts, state: 'complete', note: null, nodeId: null, parentId: null, feedback: null, ratingError: null, next: null,
    request: null, ...over,
  };
}

const TREE: TreeNode[] = [{ id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' }];
const ASKED = msg('m1', 'user', [text('m1t', 'How was December?')], { nodeId: 'u1' });
const SAVED = msg('m2', 'assistant', [text('m2t', 'December was busy.')], { nodeId: 'a1', parentId: 'u1' });

type ReplyProps = React.ComponentProps<typeof ReplyView>;
type UserProps = React.ComponentProps<typeof UserMessage>;

function replyProps(over: Partial<ReplyProps> = {}): ReplyProps {
  return {
    message: SAVED, ctx: CTX, tree: TREE, newest: true, chat: fakeChat(), locationId: 'l1', readOnlyId: null, canAct: true,
    onRetry: jest.fn(), ...over,
  };
}

function userProps(over: Partial<UserProps> = {}): UserProps {
  return { message: ASKED, tree: TREE, chat: fakeChat(), readOnlyId: null, busy: false, ...over };
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
  expect(screen.queryByText('TownwiseAI is thinking…')).toBeNull();
  for (const state of ['complete', 'stopped', 'failed'] as const) {
    view.rerender(<ReplyView {...replyProps({ message: { ...live, state } })} />);
    expect(screen.queryByText('▍')).toBeNull();
  }
});

it('while it streams, the live line names the running step or says it is thinking, in small text2', () => {
  const running: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: { ...SALES_STEP.input }, result: null };
  const view = render(<ReplyView {...replyProps({ message: msg('m2', 'assistant', [], { state: 'streaming' }) })} />);
  expect(window.getComputedStyle(screen.getByText('TownwiseAI is thinking…')).color).toBe('rgb(181, 187, 194)');
  view.rerender(<ReplyView {...replyProps({ message: msg('m2', 'assistant', [{ type: 'tools', key: 'b', steps: [running] }], { state: 'streaming' }) })} />);
  expect(screen.getByText('Reading your sales for Dec 1 to Dec 31, 2025…')).toBeTruthy();
  // No actions, versions or Based on line while it streams.
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
  expect(screen.queryByText(/^Based on/)).toBeNull();
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

it('Helpful shows alone and pressed once chosen; pressing it again shows both; Not helpful asks the optional reason', () => {
  const rate = jest.fn();
  render(<RatedReply rate={rate} />);
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('false');
  expect(button('Not helpful').getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(button('Helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', 'up', undefined);
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('true');
  expect(window.getComputedStyle(button('Helpful')).backgroundColor).toBe(MINT);
  expect(screen.queryByRole('button', { name: 'Not helpful' })).toBeNull();

  fireEvent.click(button('Helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', null, undefined);
  expect(button('Helpful').getAttribute('aria-pressed')).toBe('false');
  expect(button('Not helpful').getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(button('Not helpful'));
  expect(rate).toHaveBeenLastCalledWith('m2', 'down', undefined);
  expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
  const reasons = screen.getByRole('group', { name: 'What went wrong? Optional.' });
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

it('Edit is aria-disabled while a reply streams and under view-as, and absent before the message is saved', () => {
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

/** A thread whose version switch reads the other version as useTuningChat does: every message comes back new. */
function SwitchingThread(): React.JSX.Element {
  const [shown, setShown] = useState({ messages: [ASKED, { ...SAVED, nodeId: 'a1b' }], switching: false });
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
      {shown.messages.map((message) => (message.role === 'user'
        ? <UserMessage key={message.key} {...userProps({ chat, message, tree: REPLIES, busy: shown.switching })} />
        : <ReplyView key={message.key} {...replyProps({ chat, message, tree: REPLIES, canAct: !shown.switching })} />))}
    </>
  );
}

it('a version switch keeps focus on the pressed arrow and says which version shows', async () => {
  render(<SwitchingThread />);
  const next = button('Next version');
  act(() => { next.focus(); });
  fireEvent.click(next);
  expect(await screen.findByText('Showing version 3 of 3.')).toBeTruthy();
  expect(screen.getByText('Version 3 of 3')).toBeTruthy();
  expect(document.activeElement).toBe(button('Next version'));
  expect(document.activeElement).not.toBe(next);
  expect(screen.getByText('Showing version 3 of 3.').closest('[aria-live="polite"]')).not.toBeNull();
});

/** A newest reply that regenerates: the stream replaces it, then the turn is saved as its second version. */
function RegeneratingThread(): React.JSX.Element {
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
    </>
  );
}

it('Regenerate moves focus to the new reply’s version navigator once it is saved', async () => {
  render(<RegeneratingThread />);
  const regenerate = button('Regenerate');
  act(() => { regenerate.focus(); });
  fireEvent.click(regenerate);
  expect(screen.getByText('TownwiseAI is thinking…')).toBeTruthy();
  expect(await screen.findByText('Version 2 of 2')).toBeTruthy();
  expect(document.activeElement).toBe(button('Previous version'));
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
  expect(style.backgroundColor).toBe('rgb(16, 19, 23)');
  expect(style.borderTopColor).toBe('rgb(52, 56, 62)');
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
