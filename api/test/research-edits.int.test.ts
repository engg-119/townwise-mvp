// D66's hand edits (openspec change town-research-agent, task 6.1, design decision 11): PATCH
// /api/org/locations/:locationId/research/events/:eventId appends a revision (edit, hide, restore) at one location,
// based on the head the person saw. Organization A's hide never changes B's calendar, two edits from one head race on
// the unique index (one wins, the other answers 409 changed_since with the event as it is now), an edit racing
// TownwiseAI's Undo loses or wins the same way, restore returns research's own values, and a hidden event stays hidden
// when research finds it again. Fixtures are made-up places and organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { EventInsertBase } from '../src/stores/research-shared.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const RUN = new Types.ObjectId().toHexString();
const RANGE = '?from=2026-06-01&to=2026-07-31';

let server: TownwiseTestServer;

interface Tenant { orgId: string; scope: OrgScope; locationId: string; member: TestSession }

async function tenant(name: string): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `${name} ${randomUUID().slice(0, 6)}` });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email });
  const locationId = await addLocation(server, { orgId, name: `${name} Main Room` });
  return { orgId, scope: scopeForNewOrg(STAFF, orgId), locationId, member };
}

function row(over: Partial<EventInsertBase> = {}): EventInsertBase {
  const at = server.clock.now();
  return {
    title: 'Riverbank Trivia Night', titleKey: 'riverbank trivia night', kind: 'event', category: 'dining', start: '2026-06-10',
    end: '2026-06-10', weekdays: null, startTime: '19:00', status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
    sources: [{ label: 'example.test', url: 'https://example.test/trivia' }], firstRunId: RUN, lastRunId: RUN,
    firstSeenAt: at, lastSeenAt: at, seenCount: 1, ...over,
  };
}

async function townEvent(over: Partial<EventInsertBase> = {}): Promise<string> {
  const record = await server.ctx.stores.researchTowns.insertEvent('hanover-nh', row({ title: 'Green Summer Fair', titleKey: 'green summer fair', category: 'festival', ...over }));
  return `t-${record.id}`;
}

async function ownEvent(t: Tenant, over: Partial<EventInsertBase> = {}): Promise<string> {
  const record = await server.ctx.stores.researchLocations.insertEvent(t.scope, t.locationId, {
    ...row(over), placeId: null, town: 'hanover-nh', origin: 'neighborhood', competitorEntityId: null, competitorPlaceId: null,
  });
  return `l-${record.id}`;
}

function patch(t: Tenant, eventId: string, json: unknown, locationId = t.locationId) {
  return call(server, `/api/org/locations/${locationId}/research/events/${eventId}`, { method: 'PATCH', session: t.member, json });
}

interface EventBody { id: string; head: string; title: string; start: string; end: string; where: string | null; hidden: boolean; edited: boolean }

async function found(t: Tenant): Promise<EventBody[]> {
  const res = await call(server, `/api/org/locations/${t.locationId}/calendar${RANGE}`, { session: t.member });
  expect(res.status).toBe(200);
  return ((await res.json()) as { found: EventBody[] }).found;
}

async function revisionsOf(t: Tenant) {
  return server.connection.collection('tw_research_revisions').find({ orgId: new Types.ObjectId(t.orgId) }).toArray();
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  server = await startTownwiseServer();
  a = await tenant('Alpine Tavern');
  b = await tenant('Beachside Bistro');
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  for (const name of ['tw_town_events', 'tw_location_events', 'tw_research_revisions']) await server.connection.collection(name).deleteMany({});
});

describe('PATCH .../research/events/:eventId', () => {
  it('a hide by A’s member hides the shared town row at A’s location only: B still sees it, and B holds no revision', async () => {
    const eventId = await townEvent();
    const res = await patch(a, eventId, { op: 'hide', basedOn: 'base' });
    expect(res.status).toBe(200);
    const { event } = await res.json() as { event: EventBody };
    expect(event).toMatchObject({ id: eventId, hidden: true, edited: false });
    expect(event.head).toMatch(/^[0-9a-f]{24}$/);
    expect((await found(a)).map((view) => view.id)).not.toContain(eventId);
    expect((await found(b)).map((view) => view.id)).toContain(eventId);
    expect(await revisionsOf(b)).toEqual([]);
    const [revision] = await revisionsOf(a);
    expect(revision).toMatchObject({ eventId, op: 'hide', basedOn: 'base', by: { kind: 'person', userId: a.member.userId } });
    // The audit event carries the ids only.
    const audit = await server.connection.collection('tw_audit_events').findOne({ orgId: new Types.ObjectId(a.orgId), action: 'research.event_hidden' });
    expect(audit).toMatchObject({ target: { type: 'research_event', id: eventId }, details: { locationId: a.locationId, eventId } });
    // B may hide the same row from its own base: A's revision is not B's chain.
    expect((await patch(b, eventId, { op: 'hide', basedOn: 'base' })).status).toBe(200);
  });

  it('edits over the state before, and restore returns research’s own values, shown', async () => {
    const eventId = await ownEvent(a);
    const edited = await patch(a, eventId, {
      op: 'edit', basedOn: 'base', fields: { title: '  Riverbank Quiz Night ', start: '2026-06-11', end: '2026-06-11', where: 'Riverbank Hall' },
    });
    expect(edited.status).toBe(200);
    const first = (await edited.json() as { event: EventBody }).event;
    expect(first).toMatchObject({ title: 'Riverbank Quiz Night', start: '2026-06-11', where: 'Riverbank Hall', edited: true, hidden: false });
    const hidden = await patch(a, eventId, { op: 'hide', basedOn: first.head });
    const second = (await hidden.json() as { event: EventBody }).event;
    expect(second).toMatchObject({ title: 'Riverbank Quiz Night', hidden: true });
    const restored = await patch(a, eventId, { op: 'restore', fields: null, basedOn: second.head });
    expect(restored.status).toBe(200);
    expect((await restored.json() as { event: EventBody }).event).toMatchObject({
      title: 'Riverbank Trivia Night', start: '2026-06-10', where: null, edited: false, hidden: false,
    });
    expect((await revisionsOf(a)).map((each) => String(each.op))).toEqual(['edit', 'hide', 'restore']);
  });

  it('two edits from the same head: one wins, the other answers 409 changed_since with the winner’s head', async () => {
    const eventId = await ownEvent(a);
    const [one, two] = await Promise.all([
      patch(a, eventId, { op: 'edit', basedOn: 'base', fields: { title: 'First Title' } }),
      patch(a, eventId, { op: 'edit', basedOn: 'base', fields: { title: 'Second Title' } }),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 409]);
    const [won, lost] = one.status === 200 ? [one, two] : [two, one];
    const winner = (await won.json() as { event: EventBody }).event;
    const loser = await lost.json() as { error: string; event: EventBody };
    expect(loser).toMatchObject({ error: 'changed_since', event: { id: eventId, head: winner.head, title: winner.title } });
    expect(await revisionsOf(a)).toHaveLength(1);
    // A stale head later is refused the same way, and nothing is written.
    const stale = await patch(a, eventId, { op: 'hide', basedOn: 'base' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'changed_since', event: { head: winner.head, hidden: false } });
    expect(await revisionsOf(a)).toHaveLength(1);
  });

  it('an edit racing TownwiseAI’s Undo: whichever takes the correction’s head first wins, and nothing is overwritten', async () => {
    const eventId = await ownEvent(a);
    const correctionOf = async (basedOn: string) => {
      const correction = await server.ctx.stores.researchRevisions.append(a.scope, {
        locationId: a.locationId, eventId, op: 'edit', fields: { title: 'Corrected Title' }, reverts: null, basedOn,
        by: { kind: 'chat', conversationId: new Types.ObjectId().toHexString(), changeId: new Types.ObjectId().toHexString() }, now: server.clock.now(),
      });
      if (correction === null) throw new Error('correction refused');
      return correction;
    };
    const undo = (correctionId: string) => server.ctx.stores.researchRevisions.append(a.scope, {
      locationId: a.locationId, eventId, op: 'revert', fields: null, reverts: correctionId, basedOn: correctionId,
      by: { kind: 'chat', conversationId: new Types.ObjectId().toHexString(), changeId: new Types.ObjectId().toHexString() }, now: server.clock.now(),
    });

    // The Undo first: the member's edit based on the correction answers 409 with the revert as the head.
    const correction = await correctionOf('base');
    const reverted = await undo(correction.id);
    expect(reverted).not.toBeNull();
    const late = await patch(a, eventId, { op: 'edit', basedOn: correction.id, fields: { title: 'Member Title' } });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'changed_since', event: { head: reverted?.id, title: 'Riverbank Trivia Night', edited: false } });

    // The member first: the Undo's revert based on the correction is refused by the index.
    const again = await correctionOf(reverted?.id ?? '');
    const member = await patch(a, eventId, { op: 'edit', basedOn: again.id, fields: { title: 'Member Title' } });
    expect(member.status).toBe(200);
    expect(await undo(again.id)).toBeNull();
    expect((await found(a)).find((view) => view.id === eventId)).toMatchObject({ title: 'Member Title' });
  });

  it('a hidden event stays hidden when research finds it again (a merge changes the base only)', async () => {
    const eventId = await ownEvent(a);
    expect((await patch(a, eventId, { op: 'hide', basedOn: 'base' })).status).toBe(200);
    await server.connection.collection('tw_location_events').updateOne(
      { _id: new Types.ObjectId(eventId.slice(2)) },
      { $set: { title: 'Riverbank Trivia Night Returns', lastSeenAt: server.clock.now(), lastRunId: new Types.ObjectId() }, $inc: { seenCount: 1 } },
    );
    expect((await found(a)).map((view) => view.id)).not.toContain(eventId);
    const research = await call(server, `/api/org/locations/${a.locationId}/research`, { session: a.member });
    expect((await research.json() as { hidden: { id: string; title: string }[] }).hidden)
      .toEqual([expect.objectContaining({ id: eventId, title: 'Riverbank Trivia Night Returns' })]);
  });

  it('refuses unsafe text, bad dates, a revert and an empty edit, writing nothing', async () => {
    const eventId = await ownEvent(a);
    const cases: [unknown, number, string][] = [
      [{ op: 'edit', basedOn: 'base', fields: { title: 'See https://example.test/trivia' } }, 400, 'bad_title'],
      [{ op: 'edit', basedOn: 'base', fields: { title: '   ' } }, 400, 'bad_title'],
      [{ op: 'edit', basedOn: 'base', fields: { where: 'call 603-555-0100' } }, 400, 'bad_where'],
      [{ op: 'edit', basedOn: 'base', fields: { start: '2026-06-12' } }, 400, 'bad_dates'],
      [{ op: 'edit', basedOn: 'base', fields: { start: '2026-06-10', end: '2026-08-10' } }, 400, 'bad_dates'],
      [{ op: 'edit', basedOn: 'base', fields: { weekdays: [5] } }, 400, 'bad_dates'],
      [{ op: 'edit', basedOn: 'base', fields: { start: '2026-02-30' } }, 400, 'invalid_request'],
      [{ op: 'edit', basedOn: 'base', fields: {} }, 400, 'invalid_request'],
      [{ op: 'revert', basedOn: 'base' }, 400, 'invalid_request'],
      [{ op: 'hide', basedOn: 'base', fields: { title: 'x' } }, 400, 'invalid_request'],
      [{ op: 'hide', basedOn: 'nope' }, 400, 'invalid_request'],
    ];
    for (const [json, status, error] of cases) {
      const res = await patch(a, eventId, json);
      expect({ json, status: res.status, error: (await res.json() as { error: string }).error }).toEqual({ json, status, error });
    }
    expect(await revisionsOf(a)).toEqual([]);
  });

  it('answers 404 for a curated row, a holiday, another organization’s event and any event while research is off', async () => {
    const own = await ownEvent(a);
    const bOwn = await ownEvent(b);
    const otherTown = await server.ctx.stores.researchTowns.insertEvent('ithaca-ny', row({ title: 'Gorge Music Night', titleKey: 'gorge music night' }));
    for (const eventId of [
      'hanover-nh:2026-06-14:commencement', 'us:independence-day:2026', bOwn, `l-${new Types.ObjectId().toHexString()}`, `t-${otherTown.id}`,
    ]) {
      const res = await patch(a, eventId, { op: 'hide', basedOn: 'base' });
      expect({ eventId, status: res.status }).toEqual({ eventId, status: 404 });
    }
    await server.ctx.stores.orgs.setResearch(a.scope, { on: false, at: server.clock.now(), by: a.member.userId });
    try {
      expect((await patch(a, own, { op: 'hide', basedOn: 'base' })).status).toBe(404);
    } finally {
      await server.ctx.stores.orgs.setResearch(a.scope, { on: true, at: server.clock.now(), by: a.member.userId });
    }
    expect(await revisionsOf(a)).toEqual([]);
    expect(await revisionsOf(b)).toEqual([]);
  });

  it('answers 409 too_many_edits once the location holds 1,000 revisions', async () => {
    const eventId = await ownEvent(a);
    const at = server.clock.now();
    await server.connection.collection('tw_research_revisions').insertMany(Array.from({ length: 1_000 }, (_, index) => ({
      orgId: new Types.ObjectId(a.orgId), locationId: new Types.ObjectId(a.locationId), eventId: `l-${new Types.ObjectId().toHexString()}`,
      op: 'hide', fields: null, reverts: null, basedOn: `base-${String(index)}`, by: { kind: 'person', userId: null }, createdAt: at,
    })));
    const res = await patch(a, eventId, { op: 'hide', basedOn: 'base' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'too_many_edits' });
  });
});
