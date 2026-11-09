// The conversation tree (src/chat/tree.ts): how stored messages group into nodes, the path to a leaf, and the
// message views of a path (docs/portal/tuning-chat.md section 5), without Docker.
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { newestLeafUnder, nodeIdSchema, nodesOf, pathTo } from '../src/chat/tree.ts';
import { chatMessageViews } from '../src/chat/view.ts';
import type { StoredMessage } from '../src/stores/chat-conversations.ts';

const AT = new Date('2026-06-01T12:00:00.000Z');
const TODAY = '2026-06-01';

const user = (text: string): BetaMessageParam => ({ role: 'user', content: text });
const assistant = (text: string): BetaMessageParam => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolResults = (): BetaMessageParam => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] });
const legacy = (params: BetaMessageParam[]): StoredMessage[] => params.map((param) => ({ at: AT, param: JSON.stringify(param) }));
const tagged = (nodeId: string, parentId: string | null, param: BetaMessageParam): StoredMessage => ({
  at: AT, param: JSON.stringify(param), nodeId, parentId,
});

/** u1 → a1 → u2 → a2, and u2b (a sibling of u2) → a2b. */
const forked = (): StoredMessage[] => [
  tagged('u1', null, user('first')), tagged('a1', 'u1', assistant('reply 1')),
  tagged('u2', 'a1', user('second')), tagged('a2', 'u2', assistant('reply 2')),
  tagged('u2b', 'a1', user('second, edited')), tagged('a2b', 'u2b', assistant('reply 2b')),
];

describe('nodesOf', () => {
  it('messages with no node tags read as one path with legacy ids', () => {
    const nodes = nodesOf(legacy([user('a'), assistant('b'), toolResults(), assistant('c'), user('d'), assistant('e')]));
    expect(nodes.map((n) => [n.id, n.parentId, n.role])).toEqual([
      ['legacy-0', null, 'user'], ['legacy-1', 'legacy-0', 'assistant'], ['legacy-4', 'legacy-1', 'user'], ['legacy-5', 'legacy-4', 'assistant'],
    ]);
    expect(nodes[1]?.messages).toHaveLength(3);
  });

  it('tagged messages group by node after a legacy prefix', () => {
    const stored = [
      ...legacy([user('a'), assistant('b')]),
      tagged('u2', 'legacy-1', user('c')), tagged('a2', 'u2', assistant('d')), tagged('a2', 'u2', toolResults()),
    ];
    const nodes = nodesOf(stored);
    expect(nodes.map((n) => n.id)).toEqual(['legacy-0', 'legacy-1', 'u2', 'a2']);
    expect(nodes.map((n) => n.parentId)).toEqual([null, 'legacy-0', 'legacy-1', 'u2']);
    expect(nodes[3]?.messages).toHaveLength(2);
  });
});

describe('pathTo and newestLeafUnder', () => {
  const nodes = nodesOf(forked());

  it('pathTo follows parents from the leaf, and an unknown or null leaf means the last node', () => {
    expect(pathTo(nodes, 'a2').map((n) => n.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(pathTo(nodes, null).map((n) => n.id)).toEqual(['u1', 'a1', 'u2b', 'a2b']);
    expect(pathTo(nodes, 'missing').map((n) => n.id)).toEqual(['u1', 'a1', 'u2b', 'a2b']);
    expect(pathTo([], null)).toEqual([]);
  });

  it('newestLeafUnder descends through the newest child', () => {
    expect(newestLeafUnder(nodes, 'a1')).toBe('a2b');
    expect(newestLeafUnder(nodes, 'u2')).toBe('a2');
    expect(newestLeafUnder(nodes, 'a2')).toBe('a2');
  });
});

describe('node ids', () => {
  it('accept letters, digits and hyphens up to 64 characters', () => {
    expect(nodeIdSchema.safeParse('legacy-12').success).toBe(true);
    expect(nodeIdSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(nodeIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(nodeIdSchema.safeParse('bad id').success).toBe(false);
    expect(nodeIdSchema.safeParse('').success).toBe(false);
  });
});

describe('message views of a path', () => {
  it('carry the node they came from', () => {
    const nodes = nodesOf(forked());
    expect(chatMessageViews(pathTo(nodes, 'a2'), TODAY).map((v) => v.nodeId)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(chatMessageViews(pathTo(nodes, 'a2b'), TODAY).map((v) => v.text)).toEqual(['first', 'reply 1', 'second, edited', 'reply 2b']);
  });
});
