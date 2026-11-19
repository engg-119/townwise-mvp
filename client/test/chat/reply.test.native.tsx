import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, Linking, StyleSheet } from 'react-native';

import type { ToolStep } from '../../src/chat/tools';
import type { TreeNode } from '../../src/chat/tree';
import { initialChatState, type ChatMessage, type TuningChat } from '../../src/chat/useTuningChat';
import { ReplyView } from '../../src/chat/ui/ReplyView';
import { UserMessage } from '../../src/chat/ui/UserMessage';
import { workedOpenStore } from '../../src/chat/ui/workedOpen';
import { visualTitle } from '../../src/chat/visuals/words';
import { PROPOSAL, PROPOSAL_ID, SALES_STEP } from '../helpers/chat';
import { ACCESS, meOf } from '../helpers/portal';
import { daily } from './visuals-fixtures';

// B6 on native: no clipboard module (the plan's Copy action is web only), so a reply keeps its text selectable for
// the system's long-press Copy, and every other action is there.

function fakeChat(): TuningChat {
  return {
    state: { ...initialChatState(), status: 'ready', enabled: true, conversationId: 'c1' },
    setDraft: jest.fn(), send: jest.fn(), ask: jest.fn(), tell: jest.fn(), stop: jest.fn(), stopAndSend: jest.fn(), newConversation: jest.fn(),
    openConversation: jest.fn(), deleteConversation: jest.fn(() => Promise.resolve()), rename: jest.fn(() => Promise.resolve()),
    save: jest.fn(), saveEdited: jest.fn(() => Promise.resolve()), edit: jest.fn(), cancelEdit: jest.fn(), dismiss: jest.fn(),
    reopen: jest.fn(), undo: jest.fn(), editMessage: jest.fn(), regenerate: jest.fn(), showVersion: jest.fn(), rate: jest.fn(), retry: jest.fn(),
    reload: jest.fn(), watchList: jest.fn(),
    // D28's item card: never answered here.
    loadItem: jest.fn(() => new Promise<never>(() => undefined)), keepItem: jest.fn(() => new Promise<never>(() => undefined)),
    setItemAside: jest.fn(() => new Promise<never>(() => undefined)),
  };
}

const TREE: TreeNode[] = [{ id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' }];

function msg(key: string, role: ChatMessage['role'], words: string, nodeId: string, parentId: string | null): ChatMessage {
  return {
    key, role, parts: [{ type: 'text', key: `${key}t`, text: words }], state: 'complete', note: null, nodeId, parentId, feedback: null,
    ratingError: null, next: null, request: null, startedAt: null, endedAt: null, at: null, attachments: [], sources: [],
  };
}

/** The closest Text holding `words` that draws the whole line (its outer host Text). */
function selectableText(words: string): boolean {
  let node = screen.getByText(words) as ReturnType<typeof screen.getByText> | null;
  while (node !== null) {
    if (node.props.selectable === true) return true;
    node = node.parent;
  }
  return false;
}

it('hides Copy on native and keeps the reply text selectable', async () => {
  const chat = fakeChat();
  await render(
    <>
      <UserMessage message={msg('m1', 'user', 'How was December?', 'u1', null)} tree={TREE} chat={chat} locationId="l1" readOnlyId={null} busy={false} actions="hover" onAnnounce={jest.fn()} />
      <ReplyView
        message={msg('m2', 'assistant', 'December was busy.', 'a1', 'u1')}
        ctx={{ town: 'Hanover', hasTownProfile: true }}
        tree={TREE}
        newest
        actions="hover"
        chat={chat}
        locationId="l1"
        readOnlyId={null}
        canAct
        onRetry={jest.fn()}
        onAnnounce={jest.fn()}
        workedOpen={workedOpenStore()}
      />
    </>,
  );
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Not helpful' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  expect(selectableText('December was busy.')).toBe(true);
  expect(selectableText('How was December?')).toBe(true);
  expect(screen.getByText('You said')).toBeTruthy();
  expect(screen.getByText('TownwiseAI said')).toBeTruthy();
});

it('an unsaved message keeps a 44px row hidden from screen readers, with no Edit until it is saved', async () => {
  const chat = fakeChat();
  const message = { ...msg('m1', 'user', 'How was December?', 'u1', null), nodeId: null, at: Date.now() };
  const props = { tree: TREE, chat, locationId: 'l1', readOnlyId: null, busy: false, actions: 'hover' as const, onAnnounce: jest.fn() };
  await render(<UserMessage message={message} {...props} />);
  // Hidden from screen readers, so the query has to ask for hidden elements.
  expect(screen.queryByTestId('user-actions')).toBeNull();
  const pending = screen.getByTestId('user-actions', { includeHiddenElements: true });
  expect(pending.props['aria-hidden']).toBe(true);
  expect(StyleSheet.flatten(pending.props.style)).toMatchObject({ height: 44 });
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  await screen.rerender(<UserMessage message={{ ...message, nodeId: 'u1' }} {...props} />);
  expect(screen.getByTestId('user-actions').props['aria-hidden']).toBeUndefined();
  expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
});

it('links a day read to the Calendar and a sales read to Your data on native, only for a person who may open them', async () => {
  const chat = fakeChat();
  const day: ToolStep = {
    id: 'd1', name: 'get_day', state: 'done', input: { date: '2026-05-30' },
    result: { date: '2026-05-30', hasSales: true, closed: false, noteCount: 0, eventCount: 0, sources: [] },
  };
  const sales: ToolStep = { ...SALES_STEP, state: 'done', input: { ...SALES_STEP.input }, result: { ...SALES_STEP.result } };
  const message: ChatMessage = {
    ...msg('m2', 'assistant', 'May was busy.', 'a1', 'u1'),
    parts: [{ type: 'tools', key: 'k', steps: [day, sales] }, { type: 'text', key: 't', text: 'May was busy.' }],
  };
  const props = {
    message, ctx: { town: 'Hanover', hasTownProfile: true }, tree: TREE, newest: true, actions: 'hover' as const, chat, locationId: 'l1',
    readOnlyId: null, canAct: true, onRetry: jest.fn(), onAnnounce: jest.fn(), workedOpen: workedOpenStore(),
  };
  await render(<ReplyView {...props} me={meOf(ACCESS.member)} />);
  await fireEvent.press(screen.getByRole('button', { name: /^Worked/ }));
  expect(screen.getByRole('link', { name: 'Open Sat, May 30, 2026 in Calendar' })).toBeTruthy();
  // An older result that doesn't name its upload opens Your data's list.
  expect(screen.getByRole('link', { name: 'Open Your data' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'what Townwise has for Sat, May 30, 2026' })).toBeTruthy();
  await screen.rerender(<ReplyView {...props} me={meOf(ACCESS.pending)} />);
  expect(screen.queryAllByRole('link')).toHaveLength(0);
});

it('shows every row on native, whatever the message’s place', async () => {
  const chat = fakeChat();
  await render(
    <>
      <UserMessage message={{ ...msg('m1', 'user', 'How was December?', 'u1', null), at: Date.now() }} tree={TREE} chat={chat} locationId="l1" readOnlyId={null} busy={false} actions="hover" onAnnounce={jest.fn()} />
      <ReplyView
        message={{ ...msg('m2', 'assistant', 'December was busy.', 'a1', 'u1'), at: Date.now() }}
        ctx={{ town: 'Hanover', hasTownProfile: true }}
        tree={TREE}
        newest={false}
        actions="hover"
        chat={chat}
        locationId="l1"
        readOnlyId={null}
        canAct
        onRetry={jest.fn()}
        onAnnounce={jest.fn()}
        workedOpen={workedOpenStore()}
      />
    </>,
  );
  expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy();
  expect(screen.getAllByText(/^\d{1,2}:\d{2} (AM|PM)$/)).toHaveLength(2);
});

it('shows a reply’s sources under its Based on line (D37) as source chips (D40), each named by its site and opened with Linking.openURL', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const reply: ChatMessage = {
    ...msg('m2', 'assistant', 'The fair is on Saturday.', 'a1', 'u1'),
    sources: [{ host: 'www.example.com', url: 'https://www.example.com/fair' }, { host: 'example.org', url: 'https://example.org/road?day=2' }],
  };
  await render(
    <ReplyView
      message={reply}
      ctx={{ town: 'Hanover', hasTownProfile: true }}
      tree={TREE}
      newest
      actions="hover"
      chat={fakeChat()}
      locationId="l1"
      readOnlyId={null}
      canAct
      onRetry={jest.fn()}
      onAnnounce={jest.fn()}
      workedOpen={workedOpenStore()}
    />,
  );
  expect(screen.getByText('Sources')).toBeTruthy();
  // Only the two sources are links, each a chip named by its site: for a site the manifest lacks, its host without www.
  expect(screen.getAllByRole('link')).toEqual([screen.getByRole('link', { name: 'example.com. Source' }), screen.getByRole('link', { name: 'example.org. Source' })]);
  expect(screen.getByText('example.com')).toBeTruthy();
  await fireEvent.press(screen.getByRole('link', { name: 'example.org. Source' }));
  expect(openURL).toHaveBeenCalledWith('https://example.org/road?day=2');
  await fireEvent.press(screen.getByRole('link', { name: 'example.com. Source' }));
  expect(openURL).toHaveBeenLastCalledWith('https://www.example.com/fair');
  expect(openURL).toHaveBeenCalledTimes(2);
  openURL.mockRestore();
});

describe('the Working for / Worked for timeline (owner request, 2026-11-17)', () => {
  const done: ToolStep = { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: { ...SALES_STEP.input }, result: { ...SALES_STEP.result } };
  const live: ChatMessage = {
    ...msg('m2', 'assistant', '', 'a1', 'u1'), nodeId: null, state: 'streaming', startedAt: Date.now(),
    parts: [{ type: 'thinking', key: 't', text: 'Weighing the weekend.' }],
  };
  const ended: ChatMessage = {
    ...live, state: 'complete', nodeId: 'a1', endedAt: (live.startedAt ?? 0) + 4000,
    parts: [...live.parts, { type: 'tools', key: 'b', steps: [done] }, { type: 'text', key: 'c', text: 'Done.' }],
  };

  function reply(message: ChatMessage, workedOpen: ReturnType<typeof workedOpenStore>): React.JSX.Element {
    return (
      <ReplyView
        message={message}
        ctx={{ town: 'Hanover', hasTownProfile: true }}
        tree={TREE}
        newest
        actions="hover"
        chat={fakeChat()}
        locationId="l1"
        readOnlyId={null}
        canAct
        onRetry={jest.fn()}
        onAnnounce={jest.fn()}
        workedOpen={workedOpen}
      />
    );
  }

  afterEach(() => { jest.restoreAllMocks(); });

  test('starts closed; opened while it streams, it stays open, as the same elements, when the reply ends; a new reply starts closed', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const workedOpen = workedOpenStore();
    const view = await render(reply(live, workedOpen));
    const block = screen.getByTestId('worked');
    const toggle = screen.getByRole('button', { name: /^Working for \d+ seconds?$/ });
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('Weighing the weekend.')).toBeNull();
    await fireEvent.press(toggle);
    expect(screen.getByRole('button', { name: /^Working for/ }).props.accessibilityState).toMatchObject({ expanded: true });
    const summary = screen.getByText('Weighing the weekend.');
    await view.rerender(reply(ended, workedOpen));
    expect(screen.getByTestId('worked')).toBe(block);
    expect(screen.getByText('Weighing the weekend.')).toBe(summary);
    const worked = screen.getByRole('button', { name: 'Worked for 4 seconds' });
    expect(worked.props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('your sales for Dec 1 to Dec 31, 2025')).toBeTruthy();
    await fireEvent.press(worked);
    expect(screen.getByRole('button', { name: 'Worked for 4 seconds' }).props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('Weighing the weekend.')).toBeNull();
    await view.rerender(reply({ ...live, key: 'm4' }, workedOpen));
    expect(screen.getByRole('button', { name: /^Working for/ }).props.accessibilityState).toMatchObject({ expanded: false });
  });

  test('under Reduce Motion it opens and closes at once, with nothing animated', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const timing = jest.spyOn(Animated, 'timing');
    await render(reply(ended, workedOpenStore()));
    await fireEvent.press(screen.getByRole('button', { name: 'Worked for 4 seconds' }));
    expect(screen.getByText('Weighing the weekend.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Worked for 4 seconds' }));
    expect(screen.queryByText('Weighing the weekend.')).toBeNull();
    expect(timing).not.toHaveBeenCalled();
  });

  test('otherwise its height animates open and closed, and a closing timeline is hidden from assistive tech until it has folded', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const timing = jest.spyOn(Animated, 'timing');
    await render(reply(ended, workedOpenStore()));
    await fireEvent.press(screen.getByRole('button', { name: 'Worked for 4 seconds' }));
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, useNativeDriver: false }));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    await fireEvent.press(screen.getByRole('button', { name: 'Worked for 4 seconds' }));
    expect(timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ toValue: 0 }));
    expect(screen.getByText('Weighing the weekend.', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText('Weighing the weekend.')).toBeNull();
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    expect(screen.queryByText('Weighing the weekend.', { includeHiddenElements: true })).toBeNull();
  });
});

describe('charts and cards held until the reply ends (owner, 2026-11-18)', () => {
  const card = { id: PROPOSAL_ID, proposal: PROPOSAL, status: 'open', stored: 'pending', edited: false, gone: false, error: null } as const;
  const live: ChatMessage = {
    ...msg('m2', 'assistant', '', 'a1', 'u1'), nodeId: null, state: 'streaming', startedAt: Date.now(),
    parts: [
      { type: 'text', key: 'a', text: 'December was busy.' },
      { type: 'visual', key: 'v', id: 'v1', visual: daily },
      { type: 'proposal', key: 'p', card },
      { type: 'text', key: 'b', text: 'Ask me about January.' },
      { type: 'visual', key: 'w', id: 'v2', visual: JSON.parse(JSON.stringify(daily)) as typeof daily },
    ],
  };
  const ended: ChatMessage = { ...live, state: 'complete', nodeId: 'a1', endedAt: (live.startedAt ?? 0) + 4000 };

  function reply(message: ChatMessage): React.JSX.Element {
    return (
      <ReplyView
        message={message}
        ctx={{ town: 'Hanover', hasTownProfile: true }}
        tree={TREE}
        newest
        actions="hover"
        chat={fakeChat()}
        locationId="l1"
        readOnlyId={null}
        canAct
        onRetry={jest.fn()}
        onAnnounce={jest.fn()}
        workedOpen={workedOpenStore()}
      />
    );
  }

  afterEach(() => { jest.restoreAllMocks(); });

  test('nothing held renders while it works; on done they fade in, the chart drawn twice once; a stopped reply never shows them', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const timing = jest.spyOn(Animated, 'timing');
    const view = await render(reply(live));
    expect(screen.queryAllByText(visualTitle(daily))).toHaveLength(0);
    expect(screen.queryByText('Proposed note')).toBeNull();
    expect(screen.getByText('Ask me about January.')).toBeTruthy();
    await view.rerender(reply(ended));
    const charts = screen.getAllByText(visualTitle(daily)).length;
    expect(charts).toBeGreaterThan(0);
    expect(screen.getAllByText('Proposed note').length).toBeGreaterThan(0);
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, useNativeDriver: true }));
    // The chart drawn twice shows as often as a chart drawn once does.
    await view.rerender(reply({ ...ended, key: 'm3', parts: ended.parts.slice(1, 2) }));
    expect(screen.getAllByText(visualTitle(daily))).toHaveLength(charts);
    await view.rerender(reply({ ...live, key: 'm5' }));
    await view.rerender(reply({ ...live, key: 'm5', state: 'stopped', endedAt: (live.startedAt ?? 0) + 4000 }));
    expect(screen.queryByText('Proposed note')).toBeNull();
  });

  test('under Reduce Motion they appear at once', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const timing = jest.spyOn(Animated, 'timing');
    const view = await render(reply(live));
    await view.rerender(reply(ended));
    expect(screen.getAllByText('Proposed note').length).toBeGreaterThan(0);
    expect(timing).not.toHaveBeenCalled();
  });
});
