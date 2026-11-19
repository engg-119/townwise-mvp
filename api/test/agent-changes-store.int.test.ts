// D59: tw_agent_changes, the ledger of TownwiseAI's changes (stores/agent-changes.ts), against the database: a dedupe
// key is held once per location in every status, every change of status is a compare-and-set, another organization
// reads nothing, a file's undo marks its rows, the log pages newest first, and deleting a location or an organization
// removes its rows; the action enum takes every action, (D66) `event.correct` included, and nothing else. Synthetic ids
// only.
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { AGENT_CHANGE_ACTIONS, type AgentChangeAction, type AgentChangeStore, type NewAgentChange } from '../src/stores/agent-changes.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let store: AgentChangeStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  store = server.ctx.stores.agentChanges;
});
afterAll(async () => { await server.close(); });

const id = (): string => new Types.ObjectId().toHexString();
const scopeOf = (orgId: string): OrgScope => ({ orgId }) as unknown as OrgScope;

function change(locationId: string, over: Partial<NewAgentChange> = {}): NewAgentChange {
  return {
    id: id(), locationId, sourceKind: 'file', sourceId: id(), action: 'note.add', targetId: id(), dedupeKey: `key-${id()}`,
    confidence: 'high', why: 'The file says the room is booked.', onBehalfOf: 'u1', startDate: '2026-06-14', endDate: '2026-06-14',
    noteKind: 'private_event', now: server.clock.now(), ...over,
  };
}

describe('tw_agent_changes', () => {
  it('holds a dedupe key once per location in every status, answering the row that holds it', async () => {
    const scope = scopeOf(id());
    const locationId = id();
    const first = change(locationId, { dedupeKey: 'same' });
    const made = await store.insertApplying(scope, first);
    expect(made.created).toBe(true);
    expect(made.record).toMatchObject({ status: 'applying', dedupeKey: 'same', targetUpdatedAt: null, statusBy: 'townwise_ai' });
    for (const status of ['applied', 'undoing', 'undone', 'adopted']) {
      await server.connection.collection('tw_agent_changes').updateOne({ _id: new Types.ObjectId(made.record.id) }, { $set: { status } });
      const again = await store.insertApplying(scope, change(locationId, { dedupeKey: 'same' }));
      expect(again).toMatchObject({ created: false, record: { id: made.record.id, status } });
    }
    // Another location, and another organization, may hold the same key.
    expect((await store.insertApplying(scope, change(id(), { dedupeKey: 'same' }))).created).toBe(true);
    expect((await store.insertApplying(scopeOf(id()), change(locationId, { dedupeKey: 'same' }))).created).toBe(true);
  });

  it('moves applying to applied to undoing to undone by compare-and-set, each once', async () => {
    const scope = scopeOf(id());
    const locationId = id();
    const { record } = await store.insertApplying(scope, change(locationId));
    const at = new Date('2026-06-01T10:00:00.000Z');
    expect(await store.markUndoing(scope, locationId, record.id, { by: 'u2', now: at })).toBeNull();
    expect(await store.markApplied(scope, locationId, record.id, { targetUpdatedAt: at, now: at })).toBe(true);
    expect(await store.markApplied(scope, locationId, record.id, { targetUpdatedAt: at, now: at })).toBe(false);
    expect(await store.removeApplying(scope, locationId, record.id)).toBe(false);
    expect(await store.markUndone(scope, locationId, record.id, { by: 'u2', now: at })).toBe(false);
    const undoing = await store.markUndoing(scope, locationId, record.id, { by: 'u2', now: at });
    expect(undoing).toMatchObject({ status: 'undoing', statusBy: 'u2', targetUpdatedAt: at });
    expect(await store.markUndoing(scope, locationId, record.id, { by: 'u2', now: at })).toBeNull();
    expect(await store.markUndone(scope, locationId, record.id, { by: 'u2', now: at })).toBe(true);
    expect(await store.markUndone(scope, locationId, record.id, { by: 'u2', now: at })).toBe(false);
    expect(await store.markAdopted(scope, locationId, record.id, { now: at })).toBe(false);
    expect((await store.find(scope, locationId, record.id))?.status).toBe('undone');
  });

  it('sets a row adopted from applied or undoing only, and removes a row only while it is still applying', async () => {
    const scope = scopeOf(id());
    const locationId = id();
    const now = server.clock.now();
    const a = (await store.insertApplying(scope, change(locationId))).record;
    expect(await store.markAdopted(scope, locationId, a.id, { now })).toBe(false);
    expect(await store.removeApplying(scope, locationId, a.id)).toBe(true);
    expect(await store.find(scope, locationId, a.id)).toBeNull();
    const b = (await store.insertApplying(scope, change(locationId))).record;
    await store.markApplied(scope, locationId, b.id, { targetUpdatedAt: now, now });
    expect(await store.markAdopted(scope, locationId, b.id, { now })).toBe(true);
    expect((await store.find(scope, locationId, b.id))?.status).toBe('adopted');
    const c = (await store.insertApplying(scope, change(locationId))).record;
    await store.markApplied(scope, locationId, c.id, { targetUpdatedAt: now, now });
    await store.markUndoing(scope, locationId, c.id, { by: 'u3', now });
    expect(await store.markAdopted(scope, locationId, c.id, { now })).toBe(true);
  });

  it('another organization or location reads and changes nothing', async () => {
    const scope = scopeOf(id());
    const locationId = id();
    const { record } = await store.insertApplying(scope, change(locationId, { dedupeKey: 'mine' }));
    const other = scopeOf(id());
    expect(await store.find(other, locationId, record.id)).toBeNull();
    expect(await store.find(scope, id(), record.id)).toBeNull();
    expect(await store.findByKey(other, locationId, 'mine')).toBeNull();
    expect((await store.page(other, locationId, { limit: 50 })).changes).toEqual([]);
    expect(await store.markApplied(other, locationId, record.id, { targetUpdatedAt: new Date(), now: new Date() })).toBe(false);
    expect(await store.removeApplying(other, locationId, record.id)).toBe(false);
    expect(await store.removeForOrg(other)).toBe(0);
    expect((await store.find(scope, locationId, record.id))?.status).toBe('applying');
  });

  it('a file’s undo marks its rows not yet undone or adopted, and no other file’s', async () => {
    const scope = scopeOf(id());
    const locationId = id();
    const fileId = id();
    const now = server.clock.now();
    const rows = [];
    for (let i = 0; i < 3; i += 1) rows.push((await store.insertApplying(scope, change(locationId, { sourceId: fileId }))).record);
    const [applied, adopted] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]];
    await store.markApplied(scope, locationId, applied.id, { targetUpdatedAt: now, now });
    await store.markApplied(scope, locationId, adopted.id, { targetUpdatedAt: now, now });
    await store.markAdopted(scope, locationId, adopted.id, { now });
    const elsewhere = (await store.insertApplying(scope, change(locationId))).record;
    expect(await store.markSourceUndone(scope, locationId, { kind: 'file', id: fileId }, { by: 'u4', now })).toBe(2);
    expect((await store.find(scope, locationId, adopted.id))?.status).toBe('adopted');
    expect((await store.find(scope, locationId, applied.id))?.status).toBe('undone');
    expect((await store.find(scope, locationId, elsewhere.id))?.status).toBe('applying');
  });

  it('pages a location’s changes newest first, rows sharing a time included once', async () => {
    const scope = scopeOf(id());
    const locationId = id();
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // Two rows share each time.
      made.push((await store.insertApplying(scope, change(locationId, { now: new Date(base + Math.floor(i / 2) * 1000) }))).record.id);
    }
    const first = await store.page(scope, locationId, { limit: 2 });
    expect(first.changes).toHaveLength(2);
    const second = await store.page(scope, locationId, { limit: 2, ...(first.next === null ? {} : { before: first.next }) });
    const third = await store.page(scope, locationId, { limit: 2, ...(second.next === null ? {} : { before: second.next }) });
    expect(third.next).toBeNull();
    const ids = [...first.changes, ...second.changes, ...third.changes].map((row) => row.id);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual([...made].sort());
    const times = [...first.changes, ...second.changes, ...third.changes].map((row) => row.appliedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('deleting a location or an organization removes its rows only', async () => {
    const scope = scopeOf(id());
    const [kept, gone] = [id(), id()];
    await store.insertApplying(scope, change(kept));
    await store.insertApplying(scope, change(gone));
    expect(await store.removeForLocation(scope, gone)).toBe(1);
    expect((await store.page(scope, kept, { limit: 50 })).changes).toHaveLength(1);
    expect(await store.removeForOrg(scope)).toBe(1);
    expect((await store.page(scope, kept, { limit: 50 })).changes).toEqual([]);
  });

  it('takes every action, a correction of a researched event (D66) included, and refuses any other', async () => {
    expect(AGENT_CHANGE_ACTIONS).toEqual(['note.add', 'item.add', 'sales_days.add', 'rule.add', 'booking.label', 'event.correct']);
    const scope = scopeOf(id());
    const locationId = id();
    const made = await store.insertApplying(scope, change(locationId, {
      sourceKind: 'chat', action: 'event.correct', startDate: null, endDate: null, why: null,
    }));
    expect(made.record).toMatchObject({ action: 'event.correct', sourceKind: 'chat', confidence: 'high', startDate: null, endDate: null, status: 'applying' });
    expect((await store.find(scope, locationId, made.record.id))?.action).toBe('event.correct');
    await expect(store.insertApplying(scope, change(locationId, { action: 'event.delete' as AgentChangeAction }))).rejects.toThrow();
  });
});
