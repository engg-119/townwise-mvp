// GET /api/org/locations/:locationId/chat/:conversationId for conversation trees (docs/portal/tuning-chat.md
// sections 2 and 5): the tree, the active leaf, node ids on messages, `?node=`, and legacy conversations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chatConversationModel } from '../src/stores/chat-conversations.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import { addConversation, addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let orgId: string;
let locationId: string;
let author: TestSession;
let colleague: TestSession;
let legacyId: string;
let treeId: string;

const text = (value: string) => [{ type: 'text', text: value }];

async function seedTree(): Promise<string> {
  const at = server.clock.now();
  const message = (nodeId: string, parentId: string | null, role: 'user' | 'assistant', value: string) => ({
    at, nodeId, parentId, param: JSON.stringify({ role, content: role === 'user' ? value : text(value) }),
  });
  const _id = new Types.ObjectId();
  await chatConversationModel(server.connection).collection.insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), userId: author.userId, title: 'first',
    messages: [
      message('u1', null, 'user', 'first'), message('a1', 'u1', 'assistant', 'reply 1'),
      message('u2', 'a1', 'user', 'second'), message('a2', 'u2', 'assistant', 'reply 2'),
      message('u2b', 'a1', 'user', 'second, edited'), message('a2b', 'u2b', 'assistant', 'reply 2b'),
    ],
    activeLeafId: 'a2', turnCount: 2, liveTurn: null, createdAt: at, updatedAt: at,
  });
  return _id.toHexString();
}

async function getConversation(id: string, query: { node?: string } = {}, session = author) {
  const search = query.node === undefined ? '' : `?node=${query.node}`;
  return call(server, `/api/org/locations/${locationId}/chat/${id}${search}`, { session });
}

beforeAll(async () => {
  server = await startTownwiseServer({});
  orgId = await createOrg(server, { name: 'Tree Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  const person = async (name: string) => {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email, role: 'member' });
    return session;
  };
  author = await person('author');
  colleague = await person('colleague');
  legacyId = await addConversation(server, { orgId, locationId, userId: author.userId, text: 'Legacy question' });
  treeId = await seedTree();
});

afterAll(async () => {
  await server.close();
});

describe('GET a conversation tree', () => {
  it('answers the tree, the active leaf and node ids; a legacy conversation is one path', async () => {
    const body = await (await getConversation(legacyId)).json() as ConversationView;
    expect(body.tree.map((n) => n.id)).toEqual(['legacy-0', 'legacy-1']);
    expect(body.activeLeafId).toBe('legacy-1');
    expect(body.messages.map((m) => m.nodeId)).toEqual(['legacy-0', 'legacy-1']);
  });

  it('shows the stored active leaf’s path, and ?node= shows the newest leaf under that node without storing it', async () => {
    const stored = await (await getConversation(treeId)).json() as ConversationView;
    expect(stored.messages.map((m) => m.text)).toEqual(['first', 'reply 1', 'second', 'reply 2']);
    expect(stored.tree).toEqual([
      { id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' },
      { id: 'u2', parentId: 'a1', role: 'user' }, { id: 'a2', parentId: 'u2', role: 'assistant' },
      { id: 'u2b', parentId: 'a1', role: 'user' }, { id: 'a2b', parentId: 'u2b', role: 'assistant' },
    ]);
    const other = await (await getConversation(treeId, { node: 'u2b' })).json() as ConversationView;
    expect(other.messages.map((m) => m.text)).toEqual(['first', 'reply 1', 'second, edited', 'reply 2b']);
    expect(other.activeLeafId).toBe('a2b');
    expect((await (await getConversation(treeId)).json() as ConversationView).activeLeafId).toBe('a2');
  });

  it('?node= with an unknown id is 404, a malformed one 400, and another person’s conversation stays 404', async () => {
    expect((await getConversation(treeId, { node: 'nope' })).status).toBe(404);
    expect((await getConversation(treeId, { node: 'bad%20id' })).status).toBe(400);
    expect((await getConversation(treeId, { node: 'u1' }, colleague)).status).toBe(404);
  });
});
