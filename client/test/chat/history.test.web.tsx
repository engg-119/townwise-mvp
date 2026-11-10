import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { ConversationSummary } from '../../src/chat/api';
import { ChatHeader } from '../../src/chat/ui/ChatHeader';

// B7 on web: the header's History disclosure, inline rename, delete's dialog, and the streaming and panel states.

afterEach(() => { cleanup(); });

const CONVERSATIONS: ConversationSummary[] = [
  { id: 'c1', title: 'Earlier chat', updatedAt: '2026-11-02T15:00:00.000Z', turnCount: 2 },
  { id: 'c2', title: 'Another chat', updatedAt: '2026-11-03T15:00:00.000Z', turnCount: 1 },
];

type Props = React.ComponentProps<typeof ChatHeader>;

function props(over: Partial<Props> = {}): Props {
  return {
    title: 'Earlier chat', conversations: CONVERSATIONS, openId: 'c1', streaming: false, readOnlyId: null, panelOpen: false,
    openQuestions: null, onOpen: jest.fn(), onNew: jest.fn(), onDelete: jest.fn(() => Promise.resolve()),
    onRename: jest.fn(() => Promise.resolve()), onTogglePanel: jest.fn(), ...over,
  };
}

it('History opens a list of conversations, Escape closes it and focus returns to History', () => {
  render(<ChatHeader {...props()} />);
  const button = screen.getByRole('button', { name: 'History' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const list = screen.getByRole('region', { name: 'History' });
  expect(within(list).getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }).getAttribute('aria-current')).toBe('true');
  expect(within(list).getByRole('button', { name: 'Another chat, Nov 3, 2026' }).getAttribute('aria-current')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: 'History' })).toBeNull();
  expect(document.activeElement).toBe(button);
});

it('says so when there are no conversations', () => {
  render(<ChatHeader {...props({ conversations: [], openId: null, title: '' })} />);
  expect(screen.getByText('New conversation')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  expect(screen.getByText('No conversations yet.')).toBeTruthy();
});

it('opens a conversation from its row, and focus goes back to History as the list closes', () => {
  const p = props();
  render(<ChatHeader {...p} />);
  const history = screen.getByRole('button', { name: 'History' });
  fireEvent.click(history);
  const row = screen.getByRole('button', { name: 'Another chat, Nov 3, 2026' });
  act(() => { row.focus(); });
  fireEvent.click(row);
  expect(p.onOpen).toHaveBeenCalledWith('c2');
  expect(screen.queryByRole('region', { name: 'History' })).toBeNull();
  expect(document.activeElement).toBe(history);
});

it('renames a conversation inline: Enter saves through onRename, Escape cancels, a blank or 61-character title shows the message', async () => {
  const p = props();
  render(<ChatHeader {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename Another chat' }));
  let field = screen.getByLabelText('Conversation name');
  fireEvent.change(field, { target: { value: '   ' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.getByText('Use 1 to 60 characters.')).toBeTruthy();
  expect(p.onRename).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: 'x'.repeat(61) } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.getByText('Use 1 to 60 characters.')).toBeTruthy();
  expect(p.onRename).not.toHaveBeenCalled();
  // Escape cancels the field and leaves the list open, with focus back on the row's Rename.
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(screen.queryByLabelText('Conversation name')).toBeNull();
  expect(screen.getByRole('region', { name: 'History' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Another chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename Another chat' }));
  field = screen.getByLabelText('Conversation name');
  fireEvent.change(field, { target: { value: '  Holiday week  ' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => { expect(p.onRename).toHaveBeenCalledWith('c2', 'Holiday week'); });
  await waitFor(() => { expect(screen.queryByLabelText('Conversation name')).toBeNull(); });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Another chat' }));
});

it('Delete asks first and keeps the dialog’s words', async () => {
  const p = props();
  render(<ChatHeader {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete Another chat' }));
  expect(p.onDelete).not.toHaveBeenCalled();
  expect(screen.getByText('Delete this conversation?')).toBeTruthy();
  expect(screen.getByText('TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.')).toBeTruthy();
  const dialog = screen.getByRole('dialog', { name: 'Delete this conversation?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => { expect(p.onDelete).toHaveBeenCalledWith('c2'); });
});

it('after a delete, focus goes to History, since the row whose Delete opened the dialog is gone; the list stays open', async () => {
  function Harness(): React.JSX.Element {
    const [conversations, setConversations] = useState(CONVERSATIONS);
    return (
      <ChatHeader
        {...props({
          conversations,
          onDelete: (id) => {
            setConversations((list) => list.filter((conversation) => conversation.id !== id));
            return Promise.resolve();
          },
        })}
      />
    );
  }
  render(<Harness />);
  const history = screen.getByRole('button', { name: 'History' });
  fireEvent.click(history);
  const remove = screen.getByRole('button', { name: 'Delete Another chat' });
  act(() => { remove.focus(); });
  fireEvent.click(remove);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Delete' }));
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Delete this conversation?' })).toBeNull(); });
  expect(screen.queryByRole('button', { name: 'Delete Another chat' })).toBeNull();
  await waitFor(() => { expect(document.activeElement).toBe(history); });
  expect(screen.getByRole('region', { name: 'History' })).toBeTruthy();
});

it('Cancel in the delete dialog gives focus back to the row’s Delete', async () => {
  render(<ChatHeader {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  const remove = screen.getByRole('button', { name: 'Delete Another chat' });
  act(() => { remove.focus(); });
  fireEvent.click(remove);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Delete this conversation?' })).toBeNull(); });
  await waitFor(() => { expect(document.activeElement).toBe(remove); });
});

it('History and New chat are aria-disabled while a reply streams; the panel button is not', () => {
  const p = props({ streaming: true });
  render(<ChatHeader {...p} />);
  const history = screen.getByRole('button', { name: 'History' });
  const fresh = screen.getByRole('button', { name: 'New chat' });
  const panel = screen.getByRole('button', { name: 'Questions and activity' });
  expect(history.getAttribute('aria-disabled')).toBe('true');
  expect(fresh.getAttribute('aria-disabled')).toBe('true');
  expect(panel.getAttribute('aria-disabled')).toBeNull();
  fireEvent.click(history);
  fireEvent.click(fresh);
  expect(screen.queryByRole('region', { name: 'History' })).toBeNull();
  expect(p.onNew).not.toHaveBeenCalled();
  fireEvent.click(panel);
  expect(p.onTogglePanel).toHaveBeenCalledTimes(1);
});

it('the panel button names the open questions and reports aria-expanded', () => {
  const view = render(<ChatHeader {...props({ openQuestions: 3, panelOpen: true })} />);
  const panel = screen.getByRole('button', { name: 'Questions and activity (3)' });
  expect(panel.getAttribute('aria-expanded')).toBe('true');
  view.rerender(<ChatHeader {...props({ openQuestions: 0, panelOpen: false })} />);
  const closed = screen.getByRole('button', { name: 'Questions and activity' });
  expect(closed.getAttribute('aria-expanded')).toBe('false');
});
