import { draftKey, readDraft, resetDrafts, writeDraft } from '../../src/chat/drafts';

it('keeps one draft per person, location and conversation, in memory, and forgets an empty one', () => {
  const mine = draftKey('user-1', 'l1', 'c1');
  const newChat = draftKey('user-1', 'l1', null);
  const otherLocation = draftKey('user-1', 'l2', 'c1');
  const someoneElse = draftKey('user-2', 'l1', 'c1');
  expect(new Set([mine, newChat, otherLocation, someoneElse]).size).toBe(4);

  expect(readDraft(mine)).toBe('');
  writeDraft(mine, 'Closed on the 24th');
  writeDraft(newChat, 'A new question');
  expect(readDraft(mine)).toBe('Closed on the 24th');
  expect(readDraft(newChat)).toBe('A new question');
  expect(readDraft(otherLocation)).toBe('');
  expect(readDraft(someoneElse)).toBe('');

  writeDraft(mine, '');
  expect(readDraft(mine)).toBe('');
  expect(readDraft(newChat)).toBe('A new question');

  resetDrafts();
  expect(readDraft(newChat)).toBe('');
});

it('a key’s parts can’t run together', () => {
  expect(draftKey('a', 'bc', null)).not.toBe(draftKey('ab', 'c', null));
  expect(draftKey('a', 'b', 'c')).not.toBe(draftKey('a', 'b', null));
});
