import { cleanup, render, screen } from '@testing-library/react';

import type { TreeNode } from '../../src/chat/tree';
import { ReplyView } from '../../src/chat/ui/ReplyView';
import { initialChatState, type ChatMessage, type TuningChat } from '../../src/chat/useTuningChat';

// The pages a reply cites from its web searches (docs/portal/tuning-chat.md 3): Anthropic requires them shown with the
// reply, so a finished reply lists them as links under its Based on line, outside any disclosure.

afterEach(cleanup);

const TREE: TreeNode[] = [{ id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' }];
const SOURCES = [{ host: 'hanover.org', url: 'https://www.hanover.org/fair' }, { host: 'town.gov', url: 'https://town.gov/roads' }];

function reply(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    key: 'm2', role: 'assistant', parts: [{ type: 'text', key: 'm2t', text: 'The fair is on Saturday.' }], state: 'complete', note: null,
    nodeId: 'a1', parentId: 'u1', feedback: null, ratingError: null, next: null, request: null, startedAt: null, endedAt: null, ...over,
  };
}

function shown(message: ChatMessage): void {
  const chat = { state: { ...initialChatState(), status: 'ready', enabled: true, conversationId: 'c1' } } as unknown as TuningChat;
  render(
    <ReplyView
      message={message} ctx={{ town: 'Hanover', hasTownProfile: true }} tree={TREE} newest chat={chat} locationId="l1"
      readOnlyId={null} canAct onRetry={jest.fn()} onAnnounce={jest.fn()}
    />,
  );
}

test('a finished reply lists each cited page as a link that opens in a new tab', () => {
  shown(reply({ sources: SOURCES }));
  expect(screen.getByText('Sources')).toBeTruthy();
  for (const source of SOURCES) {
    const link = screen.getByRole('link', { name: source.host });
    expect(link.getAttribute('href')).toBe(source.url);
    expect(link.getAttribute('target')).toBe('_blank');
  }
});

test('a reply that cites nothing, and one still streaming, show no Sources line', () => {
  shown(reply());
  expect(screen.queryByText('Sources')).toBeNull();
  cleanup();
  shown(reply({ sources: [] }));
  expect(screen.queryByText('Sources')).toBeNull();
  cleanup();
  shown(reply({ sources: SOURCES, state: 'streaming' }));
  expect(screen.queryByText('Sources')).toBeNull();
});
