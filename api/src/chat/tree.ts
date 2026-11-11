// A tuning chat conversation is a tree of nodes (docs/portal/tuning-chat.md section 5). The stored messages stay one
// append-only array; each message may carry the id of the node it belongs to and that node's parent. A node is one
// person's message, or one reply (its assistant messages and the tool results between them). Messages written before
// trees carry no tag and read as one path with ids `legacy-{index}`. Ids only: nothing here touches message text.
import { randomUUID } from 'node:crypto';

import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';

import type { StoredMessage } from '../stores/chat-conversations.ts';

export const nodeIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export interface ChatNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: 'user' | 'assistant';
  readonly messages: readonly StoredMessage[];
}

/** What the client needs of a node to draw the version navigator. */
export interface TreeNodeView { id: string; parentId: string | null; role: 'user' | 'assistant' }

export function newNodeId(): string {
  return randomUUID();
}

function blocksOf(param: BetaMessageParam): readonly BetaContentBlockParam[] {
  if (param.role === 'system') return [];
  return typeof param.content === 'string' ? [{ type: 'text', text: param.content }] : param.content;
}

/** The nodes of a conversation, in creation order. */
export function nodesOf(stored: readonly StoredMessage[]): ChatNode[] {
  const nodes: { id: string; parentId: string | null; role: 'user' | 'assistant'; messages: StoredMessage[] }[] = [];
  stored.forEach((message, index) => {
    const last = nodes.at(-1);
    if (message.nodeId !== undefined) {
      if (last?.id === message.nodeId) {
        last.messages.push(message);
        return;
      }
      const role = (JSON.parse(message.param) as BetaMessageParam).role === 'assistant' ? 'assistant' : 'user';
      nodes.push({ id: message.nodeId, parentId: message.parentId ?? null, role, messages: [message] });
      return;
    }
    const param = JSON.parse(message.param) as BetaMessageParam;
    // A user message of tool results only belongs to the reply around it.
    const startsUser = param.role === 'user' && !blocksOf(param).every((block) => block.type === 'tool_result');
    if (!startsUser && last?.role === 'assistant') {
      last.messages.push(message);
      return;
    }
    nodes.push({ id: `legacy-${index}`, parentId: last?.id ?? null, role: startsUser ? 'user' : 'assistant', messages: [message] });
  });
  return nodes;
}

/** The nodes from the root to `leafId`. A null or unknown leaf means the path to the last node. */
export function pathTo(nodes: readonly ChatNode[], leafId: string | null): ChatNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: ChatNode[] = [];
  let node = (leafId === null ? undefined : byId.get(leafId)) ?? nodes.at(-1);
  while (node !== undefined) {
    path.push(node);
    node = node.parentId === null ? undefined : byId.get(node.parentId);
  }
  return path.reverse();
}

/** From `nodeId`, descends through each node's newest child to a leaf and resolves its id. */
export function newestLeafUnder(nodes: readonly ChatNode[], nodeId: string): string {
  const newestChild = new Map<string, string>();
  for (const node of nodes) if (node.parentId !== null) newestChild.set(node.parentId, node.id);
  let id = nodeId;
  for (let next = newestChild.get(id); next !== undefined; next = newestChild.get(id)) id = next;
  return id;
}
