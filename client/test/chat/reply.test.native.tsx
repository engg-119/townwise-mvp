import { render, screen } from '@testing-library/react-native';

import type { TreeNode } from '../../src/chat/tree';
import { initialChatState, type ChatMessage, type TuningChat } from '../../src/chat/useTuningChat';
import { ReplyView } from '../../src/chat/ui/ReplyView';
import { UserMessage } from '../../src/chat/ui/UserMessage';

// B6 on native: no clipboard module (the plan's Copy action is web only), so a reply keeps its text selectable for
// the system's long-press Copy, and every other action is there.

function fakeChat(): TuningChat {
  return {
    state: { ...initialChatState(), status: 'ready', enabled: true, conversationId: 'c1' },
    setDraft: jest.fn(), send: jest.fn(), ask: jest.fn(), stop: jest.fn(), stopAndSend: jest.fn(), newConversation: jest.fn(),
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
    ratingError: null, next: null, request: null, startedAt: null, endedAt: null,
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
      <UserMessage message={msg('m1', 'user', 'How was December?', 'u1', null)} tree={TREE} chat={chat} readOnlyId={null} busy={false} onAnnounce={jest.fn()} />
      <ReplyView
        message={msg('m2', 'assistant', 'December was busy.', 'a1', 'u1')}
        ctx={{ town: 'Hanover', hasTownProfile: true }}
        tree={TREE}
        newest
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
