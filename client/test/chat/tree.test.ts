import { siblingAt, versionsOf, withTurn, type TreeNode } from '../../src/chat/tree';

// A conversation's nodes as GET .../chat/:conversationId lists them (docs/portal/tuning-chat.md 2), in creation
// order: u1 → a1 → u2 → a2, then u2 edited (u2b, a sibling of u2) → a2b, then a2b regenerated (a2c).
const TREE: TreeNode[] = [
  { id: 'u1', parentId: null, role: 'user' },
  { id: 'a1', parentId: 'u1', role: 'assistant' },
  { id: 'u2', parentId: 'a1', role: 'user' },
  { id: 'a2', parentId: 'u2', role: 'assistant' },
  { id: 'u2b', parentId: 'a1', role: 'user' },
  { id: 'a2b', parentId: 'u2b', role: 'assistant' },
  { id: 'a2c', parentId: 'u2b', role: 'assistant' },
];

it('counts versions among siblings with the same parent and role, in creation order', () => {
  expect(versionsOf(TREE, 'u2b')).toEqual({ index: 2, count: 2, ids: ['u2', 'u2b'] });
  expect(siblingAt(TREE, 'u2b', 1)).toBeNull();
  expect(siblingAt(TREE, 'u2b', -1)).toBe('u2');
  expect(siblingAt(TREE, 'u2', 1)).toBe('u2b');
  expect(versionsOf(TREE, 'a2c')).toEqual({ index: 2, count: 2, ids: ['a2b', 'a2c'] });
});

it('a node with no siblings is version 1 of 1, and an unknown node has no versions', () => {
  expect(versionsOf(TREE, 'u1')).toEqual({ index: 1, count: 1, ids: ['u1'] });
  expect(siblingAt(TREE, 'u1', -1)).toBeNull();
  expect(siblingAt(TREE, 'u1', 1)).toBeNull();
  expect(versionsOf(TREE, 'missing')).toBeNull();
  expect(siblingAt(TREE, 'missing', 1)).toBeNull();
  expect(versionsOf([], 'u1')).toBeNull();
});

it('a second root is a version of the first message', () => {
  const tree = [...TREE, { id: 'u1b', parentId: null, role: 'user' } as const];
  expect(versionsOf(tree, 'u1b')).toEqual({ index: 2, count: 2, ids: ['u1', 'u1b'] });
});

it('withTurn appends a turn’s new nodes once, after the ones it has', () => {
  const reply: TreeNode = { id: 'a3', parentId: 'u3', role: 'assistant' };
  const next = withTurn(TREE, [{ id: 'u3', parentId: 'a2c', role: 'user' }, reply]);
  expect(next.map((node) => node.id)).toEqual([...TREE.map((node) => node.id), 'u3', 'a3']);
  // A node it already has, or one listed twice, is not added again.
  expect(withTurn(next, [reply, reply])).toEqual(next);
  // The tree it was given is unchanged.
  expect(TREE).toHaveLength(7);
});
