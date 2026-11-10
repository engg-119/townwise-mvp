// A TownwiseAI conversation's tree (docs/portal/tuning-chat.md 2): every node, in the order the server created
// them, as GET .../chat/:conversationId lists them. A node is one message of the person's or one reply. An edit adds a
// sibling of the edited message and a regenerate a sibling of the reply; the versions of a node are its siblings.

export interface TreeNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
}

/**
 * The versions of a node: its siblings with the same parent and role, in creation order, and where it is among them
 * (`index` counts from 1). Null for a node the tree doesn't have.
 */
export function versionsOf(tree: readonly TreeNode[], nodeId: string): { index: number; count: number; ids: string[] } | null {
  const node = tree.find((item) => item.id === nodeId);
  if (node === undefined) return null;
  const ids = tree.filter((item) => item.parentId === node.parentId && item.role === node.role).map((item) => item.id);
  return { index: ids.indexOf(nodeId) + 1, count: ids.length, ids };
}

/** The version one step before (-1) or after (1) a node; null past either end, or for a node the tree doesn't have. */
export function siblingAt(tree: readonly TreeNode[], nodeId: string, step: -1 | 1): string | null {
  const versions = versionsOf(tree, nodeId);
  return versions === null ? null : versions.ids[versions.index - 1 + step] ?? null;
}

/** The tree with a saved turn's new nodes after the ones it has; a node it already has is not added again. */
export function withTurn(tree: readonly TreeNode[], added: readonly TreeNode[]): TreeNode[] {
  const next = [...tree];
  for (const node of added) if (!next.some((item) => item.id === node.id)) next.push(node);
  return next;
}
