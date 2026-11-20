// D66's researched read (openspec change town-research-agent, task 5.1, design decisions 9 and 11): a location sees its
// town's unsuppressed rows and its own rows stamped with its current place and town, each folded with this location's
// revisions (an edit chain, a revert, an orphan ignored, a hide that outlives research finding the row again), never
// another organization's revisions; `[]` while the organization's switch or TOWNWISE_RESEARCH is off, and null when a
// read fails. Fixtures are made-up places and organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { readResearchedViews, researchedEventsFor, type ResearchReadContext } from '../src/research/read.ts';
import { chainOf, foldRevisions } from '../src/research/revisions.ts';
import type { LocationRecord } from '../src/stores/locations.ts';
import type { RevisionRecord } from '../src/stores/research-revisions.ts';
import type { EventInsertBase } from '../src/stores/research-shared.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const NOW = new Date('2026-11-16T12:00:00Z');
const RANGE = { from: '2026-11-01', to: '2027-01-31' };
const RUN = new Types.ObjectId().toHexString();

let server: TownwiseTestServer;
let ctx: ResearchReadContext;

beforeAll(async () => {
  server = await startTownwiseServer();
  ctx = server.ctx;
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.connection.collection('tw_town_events').deleteMany({});
  await server.connection.collection('tw_town_entities').deleteMany({});
});

interface Tenant { orgId: string; scope: OrgScope; location: LocationRecord }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Read Cafe ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  const scope = scopeForNewOrg(STAFF, orgId);
  const location = await server.ctx.stores.locations.find(scope, locationId);
  if (location === null) throw new Error('fixture location missing');
  return { orgId, scope, location };
}

function row(over: Partial<EventInsertBase> = {}): EventInsertBase {
  return {
    title: 'Riverbank Trivia Night', titleKey: 'riverbank trivia night', kind: 'event', category: 'dining', start: '2026-12-03',
    end: '2026-12-03', weekdays: null, startTime: '19:00', status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
    sources: [{ label: 'example.test', url: 'https://example.test/trivia' }], firstRunId: RUN, lastRunId: RUN,
    firstSeenAt: NOW, lastSeenAt: NOW, seenCount: 1, ...over,
  };
}

async function townRow(over: Partial<EventInsertBase> = {}) {
  return server.ctx.stores.researchTowns.insertEvent('hanover-nh', row({ title: 'Green Winter Carnival', titleKey: 'green winter carnival', category: 'festival', ...over }));
}

async function ownRow(t: Tenant, over: Partial<EventInsertBase> = {}, stamp: { placeId?: string | null; town?: string } = {}) {
  return server.ctx.stores.researchLocations.insertEvent(t.scope, t.location.id, {
    ...row(over), placeId: stamp.placeId ?? t.location.placeId, town: stamp.town ?? 'hanover-nh', origin: 'neighborhood',
    competitorEntityId: null, competitorPlaceId: null,
  });
}

let at = 0;
async function revise(t: Tenant, input: { eventId: string; op: 'edit' | 'hide' | 'restore' | 'revert'; basedOn: string; fields?: Record<string, unknown> | null; reverts?: string | null }) {
  at += 1;
  const revision = await server.ctx.stores.researchRevisions.append(t.scope, {
    locationId: t.location.id, eventId: input.eventId, op: input.op, fields: input.fields ?? null, reverts: input.reverts ?? null,
    basedOn: input.basedOn, by: { kind: 'person', userId: 'user-0001' }, now: new Date(NOW.getTime() + at * 1000),
  });
  if (revision === null) throw new Error('revision refused');
  return revision;
}

describe('researchedEventsFor', () => {
  it('answers the town’s rows and the location’s own, with t- and l- ids, heads, where and who', async () => {
    const t = await tenant();
    const venue = await server.ctx.stores.researchTowns.upsertEntity('hanover-nh', { type: 'venue', name: 'Riverside Hall', nameKey: 'riverside hall', sources: [], now: NOW });
    const host = await server.ctx.stores.researchTowns.upsertEntity('hanover-nh', { type: 'organization', name: 'Valley Arts Club', nameKey: 'valley arts club', sources: [], now: NOW });
    const town = await townRow({ venueId: venue, hostId: host });
    const suppressedId = (await townRow({ title: 'Wrong Parade', titleKey: 'wrong parade', start: '2026-12-05', end: '2026-12-05' })).id;
    await server.connection.collection('tw_town_events').updateOne({ _id: new Types.ObjectId(suppressedId) }, { $set: { suppressed: { at: NOW, code: 'wrong' } } });
    const own = await ownRow(t);
    const found = await researchedEventsFor(ctx, t.scope, t.location, RANGE);
    expect(found?.map((view) => view.id).sort()).toEqual([`l-${own.id}`, `t-${town.id}`].sort());
    const townView = found?.find((view) => view.id === `t-${town.id}`);
    expect(townView).toMatchObject({
      head: 'base', origin: 'town', where: 'Riverside Hall', who: 'Valley Arts Club', competitor: null, edited: false, hidden: false,
      lastSeenAt: NOW.toISOString(), sources: [{ label: 'example.test', url: 'https://example.test/trivia' }],
    });
    expect(found?.find((view) => view.id === `l-${own.id}`)).toMatchObject({ origin: 'neighborhood', where: null, who: null });
  });

  it('leaves out rows outside the range and rows stamped with another place or town', async () => {
    const t = await tenant();
    await ownRow(t, { start: '2027-03-01', end: '2027-03-01' });
    await ownRow(t, {}, { placeId: 'ChIJ-another-place' });
    await ownRow(t, {}, { town: 'amherst-ma' });
    const kept = await ownRow(t, { start: '2026-10-20', end: '2026-11-02', kind: 'season' });
    expect((await researchedEventsFor(ctx, t.scope, t.location, RANGE))?.map((view) => view.id)).toEqual([`l-${kept.id}`]);
  });

  it('folds an edit chain, and a revert returns the state before the revision it reverts', async () => {
    const t = await tenant();
    const own = await ownRow(t);
    const id = `l-${own.id}`;
    const first = await revise(t, { eventId: id, op: 'edit', basedOn: 'base', fields: { title: 'Riverbank Quiz Night' } });
    const second = await revise(t, { eventId: id, op: 'edit', basedOn: first.id, fields: { start: '2026-12-04', end: '2026-12-04', where: 'Back Room' } });
    let view = (await researchedEventsFor(ctx, t.scope, t.location, RANGE))?.[0];
    expect(view).toMatchObject({ id, head: second.id, title: 'Riverbank Quiz Night', start: '2026-12-04', where: 'Back Room', edited: true });
    const revert = await revise(t, { eventId: id, op: 'revert', basedOn: second.id, reverts: second.id });
    view = (await researchedEventsFor(ctx, t.scope, t.location, RANGE))?.[0];
    expect(view).toMatchObject({ head: revert.id, title: 'Riverbank Quiz Night', start: '2026-12-03', where: null, edited: true });
    const restore = await revise(t, { eventId: id, op: 'restore', basedOn: revert.id });
    view = (await researchedEventsFor(ctx, t.scope, t.location, RANGE))?.[0];
    expect(view).toMatchObject({ head: restore.id, title: 'Riverbank Trivia Night', edited: false });
  });

  it('ignores an orphaned revision and its descendants', async () => {
    const t = await tenant();
    const own = await ownRow(t);
    const id = `l-${own.id}`;
    const orphan = await revise(t, { eventId: id, op: 'edit', basedOn: new Types.ObjectId().toHexString(), fields: { title: 'Orphan Title' } });
    await revise(t, { eventId: id, op: 'hide', basedOn: orphan.id });
    const view = (await researchedEventsFor(ctx, t.scope, t.location, RANGE))?.[0];
    expect(view).toMatchObject({ id, head: 'base', title: 'Riverbank Trivia Night', edited: false });
  });

  it('a hidden row stays hidden when research finds it again, and the full read lists it with its head', async () => {
    const t = await tenant();
    const town = await townRow();
    const id = `t-${town.id}`;
    const hide = await revise(t, { eventId: id, op: 'hide', basedOn: 'base' });
    // A merge finds it again: the base changes, the revision does not.
    await server.ctx.stores.researchTowns.updateEvent('hanover-nh', town.id, {
      lastRunId: new Types.ObjectId().toHexString(), lastSeenAt: new Date(NOW.getTime() + 86_400_000), seenCount: 2,
      sources: town.sources, confidence: 'high', status: 'scheduled',
    });
    expect(await researchedEventsFor(ctx, t.scope, t.location, RANGE)).toEqual([]);
    const all = await readResearchedViews(ctx, t.scope, t.location, null);
    expect(all).toMatchObject([{ id, head: hide.id, hidden: true, confidence: 'high' }]);
  });

  it('another organization’s revisions, and another location’s, change nothing here', async () => {
    const a = await tenant();
    const b = await tenant();
    const town = await townRow();
    const id = `t-${town.id}`;
    await revise(a, { eventId: id, op: 'hide', basedOn: 'base' });
    const otherLocationId = await addLocation(server, { orgId: b.orgId, name: 'Side Room' });
    const other = await server.ctx.stores.locations.find(b.scope, otherLocationId);
    if (other === null) throw new Error('fixture location missing');
    await revise({ ...b, location: other }, { eventId: id, op: 'edit', basedOn: 'base', fields: { title: 'Side Room Title' } });
    expect(await researchedEventsFor(ctx, a.scope, a.location, RANGE)).toEqual([]);
    expect((await researchedEventsFor(ctx, b.scope, b.location, RANGE))?.[0]).toMatchObject({ id, head: 'base', title: 'Green Winter Carnival' });
  });

  it('answers [] while the organization’s switch or TOWNWISE_RESEARCH is off', async () => {
    const t = await tenant();
    await townRow();
    await ownRow(t);
    expect(await researchedEventsFor({ ...ctx, config: { research: false } }, t.scope, t.location, RANGE)).toEqual([]);
    await server.ctx.stores.orgs.setResearch(t.scope, { on: false, at: NOW, by: 'user-0001' });
    expect(await researchedEventsFor(ctx, t.scope, t.location, RANGE)).toEqual([]);
  });

  it('answers null when a read fails, logging the location id only', async () => {
    const t = await tenant();
    const failing = {
      ...ctx,
      stores: { ...ctx.stores, researchLocations: { ...ctx.stores.researchLocations, events: () => Promise.reject(new Error('Riverbank Trivia Night')) } },
    };
    const before = server.logs.length;
    expect(await researchedEventsFor(failing, t.scope, t.location, RANGE)).toBeNull();
    const lines = server.logs.slice(before).join('\n');
    expect(lines).toContain('townwise.research_read_failed');
    expect(lines).not.toContain('Riverbank');
  });

  it('a location in a town outside the twelve reads only its own rows', async () => {
    const t = await tenant();
    await townRow();
    const typed = { ...t.location, town: { townId: null, name: 'Smallville', state: 'KS' } };
    const own = await ownRow(t, {}, { town: 'typed:KS:smallville' });
    expect((await researchedEventsFor(ctx, t.scope, typed, RANGE))?.map((view) => view.id)).toEqual([`l-${own.id}`]);
  });
});

describe('foldRevisions', () => {
  const base = { title: 'Base', start: '2026-12-01', end: '2026-12-01', weekdays: null, startTime: null, where: null };
  const rev = (id: string, over: Partial<RevisionRecord>): RevisionRecord => ({
    id, locationId: 'loc', eventId: 'l-1', op: 'edit', fields: null, reverts: null, basedOn: 'base',
    by: { kind: 'person', userId: null }, createdAt: NOW, ...over,
  });

  it('leaves out other events’ revisions and follows each revision’s one child', () => {
    const list = [rev('a', {}), rev('x', { eventId: 'l-2' }), rev('b', { basedOn: 'a' }), rev('c', { basedOn: 'zz' })];
    expect(chainOf('l-1', list).map((each) => each.id)).toEqual(['a', 'b']);
  });

  it('an edit of a hidden event keeps it hidden, and a revert of a hide shows it again', () => {
    const hidden = foldRevisions('l-1', base, [rev('a', { op: 'hide' }), rev('b', { basedOn: 'a', fields: { title: 'New' } })]);
    expect(hidden).toMatchObject({ head: 'b', hidden: true, edited: true });
    const shown = foldRevisions('l-1', base, [rev('a', { op: 'hide' }), rev('b', { op: 'revert', basedOn: 'a', reverts: 'a' })]);
    expect(shown).toMatchObject({ head: 'b', hidden: false, edited: false });
  });

  it('a revert naming no earlier revision of its chain changes nothing', () => {
    const folded = foldRevisions('l-1', base, [rev('a', { fields: { title: 'New' } }), rev('b', { op: 'revert', basedOn: 'a', reverts: 'nope' })]);
    expect(folded).toMatchObject({ head: 'b', values: { title: 'New' } });
  });
});
