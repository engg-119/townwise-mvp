import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import type { TreeNode } from '../../src/chat/tree';
import { initialChatState, type ChatMessage, type TuningChat } from '../../src/chat/useTuningChat';
import { ReplyView } from '../../src/chat/ui/ReplyView';
import { UserMessage } from '../../src/chat/ui/UserMessage';

// B6 on native: no clipboard module (the plan's Copy action is web only), so a reply keeps its text selectable for
// the system's long-press Copy, and every other action is there.

function fakeChat(): TuningChat {
  return {
    state: { ...initialChatState(), status: 'ready', enabled: true, conversationId: 'c1' },
    setDraft: jest.fn(), send: jest.fn(), ask: jest.fn(), tell: jest.fn(), stop: jest.fn(), stopAndSend: jest.fn(), newConversation: jest.fn(),
    openConversation: jest.fn(), deleteConversation: jest.fn(() => Promise.resolve()), rename: jest.fn(() => Promise.resolve()),
    save: jest.fn(), saveEdited: jest.fn(() => Promise.resolve()), edit: jest.fn(), cancelEdit: jest.fn(), dismiss: jest.fn(),
    reopen: jest.fn(), editMessage: jest.fn(), regenerate: jest.fn(), showVersion: jest.fn(), rate: jest.fn(), retry: jest.fn(),
    reload: jest.fn(),
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
      />
    </>,
  );
  expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy();
  expect(screen.getAllByText(/^\d{1,2}:\d{2} (AM|PM)$/)).toHaveLength(2);
});

it('lists a reply’s sources under its Based on line (D37), each link named by its host, opened with Linking.openURL', async () => {
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
    />,
  );
  expect(screen.getByText('Sources')).toBeTruthy();
  // Only the two sources are links, each named by its host without www.
  expect(screen.getAllByRole('link')).toEqual([screen.getByRole('link', { name: 'example.com' }), screen.getByRole('link', { name: 'example.org' })]);
  await fireEvent.press(screen.getByRole('link', { name: 'example.org' }));
  expect(openURL).toHaveBeenCalledWith('https://example.org/road?day=2');
  await fireEvent.press(screen.getByRole('link', { name: 'example.com' }));
  expect(openURL).toHaveBeenLastCalledWith('https://www.example.com/fair');
  expect(openURL).toHaveBeenCalledTimes(2);
  openURL.mockRestore();
});
