// Business rules (spec 6.24, 10.16, P29): a member adds, lists, edits and deletes a location's standing facts; the 30-rule
// cap under racing adds (change, recount, revert); duplicates by case and spacing; author-or-admin edits; rules reachable
// only through their own location and organization; view-as read-only; open as admin; deletion with the location and
// the organization. The text never reaches a log line or an audit event.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { holdCalls, type Hold } from './helpers/hold.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

interface Schedule {
  kind: string; startDate: string; endDate: string | null; weekdays: number[] | null; effect: string; expectedGuests: number | null;
  startTime: string | null; endTime: string | null;
}

interface RuleView {
  id: string; text: string; addedVia: 'page' | 'townwise_ai'; createdByEmail: string; createdAt: string; updatedAt: string; canEdit: boolean;
  schedule: Schedule | null; scheduleSummary: string | null;
}

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Person { session: TestSession; email: string }
let orgId: string;
let admin: Person;
let author: Person;
let colleague: Person;

async function person(name: string, role: 'org_admin' | 'member', org = orgId): Promise<Person> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId: org, userId: session.userId, email, role });
  return { session, email };
}

beforeAll(async () => {
  orgId = await createOrg(server, { name: 'Rules Tavern' });
  admin = await person('admin', 'org_admin');
  author = await person('author', 'member');
  colleague = await person('colleague', 'member');
});

function rulesPath(location: string): string {
  return `/api/org/locations/${location}/rules`;
}

function add(location: string, text: unknown, who = author): Promise<Response> {
  return call(server, rulesPath(location), { session: who.session, json: { text } });
}

async function added(location: string, text: string, who = author): Promise<RuleView> {
  const res = await add(location, text, who);
  expect(res.status).toBe(201);
  return (await res.json() as { rule: RuleView }).rule;
}

async function listed(location: string, who = author): Promise<{ rules: RuleView[]; limit: number }> {
  const res = await call(server, rulesPath(location), { session: who.session });
  expect(res.status).toBe(200);
  return await res.json() as { rules: RuleView[]; limit: number };
}

function edit(location: string, ruleId: string, text: unknown, who = author): Promise<Response> {
  return call(server, `${rulesPath(location)}/${ruleId}`, { method: 'PATCH', session: who.session, json: { text } });
}

function remove(location: string, ruleId: string, who = author): Promise<Response> {
  return call(server, `${rulesPath(location)}/${ruleId}`, { method: 'DELETE', session: who.session });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function ruleCount(location: string): Promise<number> {
  return server.connection.collection('tw_business_rules').countDocuments({ locationId: new Types.ObjectId(location) });
}

/** Rules written straight to the collection, oldest first a second apart, by the author. */
async function seedRules(location: string, n: number, org = orgId): Promise<void> {
  const start = server.clock.now().getTime() - 3_600_000;
  await server.connection.collection('tw_business_rules').insertMany(Array.from({ length: n }, (_unused, i) => ({
    orgId: new Types.ObjectId(org), locationId: new Types.ObjectId(location), text: `Seeded rule ${String(i)}`,
    key: `seeded rule ${String(i)}`, addedVia: 'page', createdBy: author.session.userId,
    createdAt: new Date(start + i * 1000), updatedAt: new Date(start + i * 1000),
  })));
}

describe('a member’s rules', () => {
  it('a member adds, lists, edits and deletes a rule; each write is audited with ids only and the text never reaches a log', async () => {
    const location = await addLocation(server, { orgId, name: 'Taproom' });
    server.logs.length = 0;
    const rule = await added(location, '  Sentinel   closed\nMondays ');
    const now = server.clock.now().toISOString();
    expect(rule).toEqual({
      id: rule.id, text: 'Sentinel closed Mondays', addedVia: 'page', createdByEmail: author.email, createdAt: now, updatedAt: now, canEdit: true,
      schedule: null, scheduleSummary: null,
    });
    const stored = await server.connection.collection('tw_business_rules').findOne({ _id: new Types.ObjectId(rule.id) });
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      '_id', 'addedVia', 'createdAt', 'createdBy', 'key', 'locationId', 'orgId', 'text', 'updatedAt',
    ]);
    expect(stored).toMatchObject({ key: 'sentinel closed mondays', createdBy: author.session.userId });
    expect(await listed(location)).toEqual({ rules: [rule], limit: 30 });

    server.clock.advance(60_000);
    const res = await edit(location, rule.id, 'Sentinel closed Mondays and Tuesdays');
    expect(res.status).toBe(200);
    expect((await res.json() as { rule: RuleView }).rule).toEqual({
      ...rule, text: 'Sentinel closed Mondays and Tuesdays', updatedAt: server.clock.now().toISOString(),
    });
    expect((await remove(location, rule.id)).status).toBe(204);
    expect(await listed(location)).toEqual({ rules: [], limit: 30 });
    expect(await errorOf(await remove(location, rule.id))).toEqual({ status: 404, error: 'not_found' });

    const events = (await auditEvents(server)).filter((e) => (e.target as { id: string }).id === rule.id);
    expect(events.map((e) => [e.action, e.target, e.details, e.actorUserId])).toEqual([
      ['rule.created', { type: 'rule', id: rule.id }, { locationId: location, via: 'page', scheduled: false }, author.session.userId],
      ['rule.updated', { type: 'rule', id: rule.id }, { locationId: location, scheduled: false }, author.session.userId],
      ['rule.deleted', { type: 'rule', id: rule.id }, { locationId: location }, author.session.userId],
    ]);
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Sentinel');
    expect(server.logs.join('\n')).not.toContain('Sentinel');
  });

  it('lists oldest first, with who added each and canEdit for the author and org admins only', async () => {
    const location = await addLocation(server, { orgId, name: 'List Room' });
    const first = await added(location, 'Closed Mondays', colleague);
    server.clock.advance(1000);
    const second = await added(location, 'Patio opens in May', admin);
    server.clock.advance(1000);
    const third = await added(location, 'Brunch only on weekends', author);
    expect((await listed(location, author)).rules.map((r) => [r.id, r.createdByEmail, r.canEdit])).toEqual([
      [first.id, colleague.email, false], [second.id, admin.email, false], [third.id, author.email, true],
    ]);
    expect((await listed(location, admin)).rules.map((r) => r.canEdit)).toEqual([true, true, true]);
  });

  it('an edit to the same text answers 200 with no write and no event', async () => {
    const location = await addLocation(server, { orgId, name: 'Same Room' });
    const rule = await added(location, 'Closed Mondays');
    server.clock.advance(60_000);
    const res = await edit(location, rule.id, ' Closed  Mondays ');
    expect(res.status).toBe(200);
    expect((await res.json() as { rule: RuleView }).rule).toEqual(rule);
    const actions = (await auditEvents(server)).filter((e) => (e.target as { id: string }).id === rule.id).map((e) => e.action);
    expect(actions).toEqual(['rule.created']);
    // A change of case alone is an edit of the same rule.
    const recased = await edit(location, rule.id, 'closed mondays');
    expect(recased.status).toBe(200);
    expect((await recased.json() as { rule: RuleView }).rule.text).toBe('closed mondays');
  });

  it('refuses a rule that is empty, over 200 characters, has a control character, or a body with other keys', async () => {
    const location = await addLocation(server, { orgId, name: 'Refused Room' });
    for (const body of [{ text: '' }, { text: '   ' }, { text: 'a'.repeat(201) }, { text: 'Closed\u0000Mondays' }, { text: 7 }, {}, { text: 'Closed', via: 'page' }]) {
      const res = await call(server, rulesPath(location), { session: author.session, json: body });
      expect({ body, ...(await errorOf(res)) }).toEqual({ body, status: 400, error: 'invalid_request' });
    }
    expect(await ruleCount(location)).toBe(0);
    const rule = await added(location, 'a'.repeat(200));
    expect(await errorOf(await edit(location, rule.id, ''))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await call(server, `${rulesPath(location)}/not-an-id`, { method: 'DELETE', session: admin.session })))
      .toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await call(server, rulesPath('not-an-id'), { session: admin.session }))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('a rule that differs only in case or spacing is 409 rule_exists, on add and on edit', async () => {
    const location = await addLocation(server, { orgId, name: 'Duplicate Room' });
    await added(location, 'Closed Mondays');
    const other = await added(location, 'Patio opens in May');
    expect(await errorOf(await add(location, '  closed   MONDAYS'))).toEqual({ status: 409, error: 'rule_exists' });
    expect(await errorOf(await edit(location, other.id, 'CLOSED mondays'))).toEqual({ status: 409, error: 'rule_exists' });
    expect((await listed(location)).rules.map((r) => r.text)).toEqual(['Closed Mondays', 'Patio opens in May']);
    // Another location may hold the same rule.
    const elsewhere = await addLocation(server, { orgId, name: 'Duplicate Patio' });
    expect((await add(elsewhere, 'Closed Mondays')).status).toBe(201);
  });

  it('only the author or an org admin edits or deletes; another member is 403 forbidden and nothing changes', async () => {
    const location = await addLocation(server, { orgId, name: 'Owned Room' });
    const rule = await added(location, 'Closed Mondays');
    const before = await server.connection.collection('tw_business_rules').findOne({ _id: new Types.ObjectId(rule.id) });
    expect(await errorOf(await edit(location, rule.id, 'Closed Sundays', colleague))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await remove(location, rule.id, colleague))).toEqual({ status: 403, error: 'forbidden' });
    expect(await server.connection.collection('tw_business_rules').findOne({ _id: new Types.ObjectId(rule.id) })).toEqual(before);
    expect((await edit(location, rule.id, 'Closed Sundays', admin)).status).toBe(200);
    expect((await remove(location, rule.id, admin)).status).toBe(204);
    const actors = (await auditEvents(server)).filter((e) => (e.target as { id: string }).id === rule.id).map((e) => [e.action, e.actorUserId]);
    expect(actors).toEqual([
      ['rule.created', author.session.userId], ['rule.updated', admin.session.userId], ['rule.deleted', admin.session.userId],
    ]);
  });

  it('a rule by a person whose account is gone shows as Deleted person', async () => {
    const location = await addLocation(server, { orgId, name: 'Gone Room' });
    const now = server.clock.now();
    await server.connection.collection('tw_business_rules').insertOne({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(location), text: 'Closed Mondays', key: 'closed mondays',
      addedVia: 'townwise_ai', createdBy: new Types.ObjectId().toHexString(), createdAt: now, updatedAt: now,
    });
    expect((await listed(location, admin)).rules.map((r) => [r.text, r.addedVia, r.createdByEmail, r.canEdit])).toEqual([
      ['Closed Mondays', 'townwise_ai', 'Deleted person', true],
    ]);
  });
});

describe('a rule’s schedule (D31)', () => {
  const CLOSED_MONDAYS: Schedule = {
    kind: 'closure', startDate: '2026-12-07', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
  };
  const SATURDAY_PARTY: Schedule = {
    kind: 'private_event', startDate: '2026-12-05', endDate: '2027-03-27', weekdays: [6], effect: 'more_guests', expectedGuests: 40,
    startTime: '18:00', endTime: '21:00',
  };
  let held: Hold[] = [];
  afterEach(() => {
    for (const hold of held) hold.restore();
    held = [];
  });

  async function stored(ruleId: string): Promise<Record<string, unknown> | null> {
    return await server.connection.collection('tw_business_rules').findOne({ _id: new Types.ObjectId(ruleId) });
  }

  it('a rule added with a schedule returns it with its summary; the event says only that it is scheduled; a rule without one stores no schedule', async () => {
    const location = await addLocation(server, { orgId, name: 'Scheduled Room' });
    server.logs.length = 0;
    const res = await call(server, rulesPath(location), { session: author.session, json: { text: 'Sentinel shut Mondays', schedule: CLOSED_MONDAYS } });
    expect(res.status).toBe(201);
    const rule = (await res.json() as { rule: RuleView }).rule;
    expect(rule).toMatchObject({ text: 'Sentinel shut Mondays', schedule: CLOSED_MONDAYS, scheduleSummary: 'Closed on Mondays from Dec 7, 2026' });
    expect((await stored(rule.id))?.schedule).toEqual(CLOSED_MONDAYS);
    expect((await listed(location)).rules).toEqual([rule]);
    const plain = await added(location, 'Patio opens in May');
    expect(plain).toMatchObject({ schedule: null, scheduleSummary: null });
    expect(Object.keys(await stored(plain.id) ?? {})).not.toContain('schedule');
    expect((await call(server, rulesPath(location), { session: author.session, json: { text: 'Brunch on Sundays', schedule: null } })).status).toBe(201);
    const created = (await auditEvents(server)).filter((e) => e.action === 'rule.created' && (e.details as { locationId?: string }).locationId === location);
    expect(created.map((e) => e.details)).toEqual([
      { locationId: location, via: 'page', scheduled: true }, { locationId: location, via: 'page', scheduled: false },
      { locationId: location, via: 'page', scheduled: false },
    ]);
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Sentinel');
    expect(server.logs.join('\n')).not.toMatch(/Sentinel|2026-12-07/);
  });

  it('PATCH sets, changes and takes off the schedule alone; an unchanged schedule writes nothing', async () => {
    const location = await addLocation(server, { orgId, name: 'Patched Room' });
    const rule = await added(location, 'Closed Mondays');
    server.clock.advance(60_000);
    const set = await edit(location, rule.id, undefined);
    expect(await errorOf(set)).toEqual({ status: 400, error: 'invalid_request' });
    const scheduled = await call(server, `${rulesPath(location)}/${rule.id}`, { method: 'PATCH', session: author.session, json: { schedule: CLOSED_MONDAYS } });
    expect(scheduled.status).toBe(200);
    expect((await scheduled.json() as { rule: RuleView }).rule).toMatchObject({
      text: 'Closed Mondays', schedule: CLOSED_MONDAYS, scheduleSummary: 'Closed on Mondays from Dec 7, 2026', updatedAt: server.clock.now().toISOString(),
    });
    // The same schedule again, with or without the same text: 200, no write and no event.
    server.clock.advance(60_000);
    const same = await call(server, `${rulesPath(location)}/${rule.id}`, {
      method: 'PATCH', session: author.session, json: { text: 'Closed Mondays', schedule: { ...CLOSED_MONDAYS, weekdays: [1] } },
    });
    expect((await same.json() as { rule: RuleView }).rule.updatedAt).not.toBe(server.clock.now().toISOString());
    const cleared = await call(server, `${rulesPath(location)}/${rule.id}`, { method: 'PATCH', session: admin.session, json: { schedule: null } });
    expect((await cleared.json() as { rule: RuleView }).rule).toMatchObject({ schedule: null, scheduleSummary: null });
    expect(Object.keys(await stored(rule.id) ?? {})).not.toContain('schedule');
    const updates = (await auditEvents(server)).filter((e) => e.action === 'rule.updated' && (e.target as { id: string }).id === rule.id);
    expect(updates.map((e) => [e.details, e.actorUserId])).toEqual([
      [{ locationId: location, scheduled: true }, author.session.userId], [{ locationId: location, scheduled: false }, admin.session.userId],
    ]);
  });

  it('refuses a schedule a note’s rules refuse, a detail on it, or a body with neither field, and writes nothing', async () => {
    const location = await addLocation(server, { orgId, name: 'Refused Schedule Room' });
    const rule = await added(location, 'Closed Mondays');
    for (const bad of [
      { ...CLOSED_MONDAYS, expectedGuests: 20 }, { ...CLOSED_MONDAYS, endDate: '2026-12-01' }, { ...CLOSED_MONDAYS, detail: 'Smith party' },
      { ...CLOSED_MONDAYS, title: 'Holiday party' }, { ...CLOSED_MONDAYS, title: null },
      { ...CLOSED_MONDAYS, startDate: '2028-12-01' }, { ...SATURDAY_PARTY, startTime: '21:00', endTime: '18:00' }, 'closed Mondays',
    ]) {
      expect(await errorOf(await call(server, rulesPath(location), { session: author.session, json: { text: 'Shut Mondays', schedule: bad } })))
        .toEqual({ status: 400, error: 'invalid_request' });
      expect(await errorOf(await call(server, `${rulesPath(location)}/${rule.id}`, { method: 'PATCH', session: author.session, json: { schedule: bad } })))
        .toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await errorOf(await call(server, `${rulesPath(location)}/${rule.id}`, { method: 'PATCH', session: author.session, json: {} })))
      .toEqual({ status: 400, error: 'invalid_request' });
    expect(await ruleCount(location)).toBe(1);
    expect(Object.keys(await stored(rule.id) ?? {})).not.toContain('schedule');
  });

  it('an edit of the text and an edit of the schedule racing both land: each writes only the field it changed', async () => {
    const location = await addLocation(server, { orgId, name: 'Racing Edits Room' });
    const rule = await added(location, 'Parties on Saturdays');
    const writes = holdCalls(server, 'findOneAndUpdate', 'TwBusinessRule');
    held.push(writes);
    const path = `${rulesPath(location)}/${rule.id}`;
    // Both read the rule before either writes; each sends the other field as it read it.
    const textEdit = call(server, path, { method: 'PATCH', session: author.session, json: { text: 'Rehearsal dinners on Saturdays', schedule: null } });
    await writes.arrived(1);
    const scheduleEdit = call(server, path, { method: 'PATCH', session: admin.session, json: { text: 'Parties on Saturdays', schedule: SATURDAY_PARTY } });
    await writes.arrived(2);
    writes.release(2);
    writes.release(1);
    const [a, b] = await Promise.all([textEdit, scheduleEdit]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await listed(location)).rules.map((r) => [r.text, r.schedule])).toEqual([['Rehearsal dinners on Saturdays', SATURDAY_PARTY]]);
  });

  it('taking the schedule off while another edit changes the text with the old schedule leaves no schedule and the new text', async () => {
    const location = await addLocation(server, { orgId, name: 'Racing Clear Room' });
    const res = await call(server, rulesPath(location), { session: author.session, json: { text: 'Parties on Saturdays', schedule: SATURDAY_PARTY } });
    const rule = (await res.json() as { rule: RuleView }).rule;
    const writes = holdCalls(server, 'findOneAndUpdate', 'TwBusinessRule');
    held.push(writes);
    const path = `${rulesPath(location)}/${rule.id}`;
    const clear = call(server, path, { method: 'PATCH', session: admin.session, json: { schedule: null } });
    await writes.arrived(1);
    const retext = call(server, path, { method: 'PATCH', session: author.session, json: { text: 'Big parties on Saturdays', schedule: SATURDAY_PARTY } });
    await writes.arrived(2);
    writes.release(1);
    expect((await clear).status).toBe(200);
    writes.release(2);
    expect((await retext).status).toBe(200);
    expect((await listed(location)).rules.map((r) => [r.text, r.schedule])).toEqual([['Big parties on Saturdays', null]]);
  });
});

describe('the 30-rule limit', () => {
  let held: Hold[] = [];
  afterEach(() => {
    for (const hold of held) hold.restore();
    held = [];
  });
  function hold(method: 'countDocuments' | 'deleteOne'): Hold {
    const found = holdCalls(server, method, 'TwBusinessRule');
    held.push(found);
    return found;
  }

  it('the 31st rule is 409 rule_limit; another location still takes rules', async () => {
    const full = await addLocation(server, { orgId, name: 'Full Room' });
    await seedRules(full, 29);
    expect((await add(full, 'The thirtieth rule')).status).toBe(201);
    expect(await errorOf(await add(full, 'The thirty-first rule'))).toEqual({ status: 409, error: 'rule_limit' });
    expect(await ruleCount(full)).toBe(30);
    expect((await listed(full)).rules).toHaveLength(30);
    const other = await addLocation(server, { orgId, name: 'Roomy Patio' });
    expect((await add(other, 'The thirty-first rule')).status).toBe(201);
  });

  it('two adds racing at 29 rules leave 30 when one recounts after the other settles', async () => {
    const location = await addLocation(server, { orgId, name: 'Race Room' });
    await seedRules(location, 29);
    const counts = hold('countDocuments');
    const first = add(location, 'First racer');
    await counts.arrived(1);                // the first's limit check
    const second = add(location, 'Second racer');
    await counts.arrived(2);                // the second's limit check: both see 29
    counts.release(1);
    counts.release(2);
    await counts.arrived(3);
    await counts.arrived(4);                // both have written: 31 rows
    counts.release(3);                      // one recounts 31 and reverts
    const settled = await Promise.race([first.then(() => 'first'), second.then(() => 'second')]);
    counts.open();                          // the other recounts 30 and stands
    const [a, b] = await Promise.all([first, second]);
    const statuses = [a.status, b.status];
    expect(statuses.sort()).toEqual([201, 409]);
    expect(await errorOf(settled === 'first' ? a : b)).toEqual({ status: 409, error: 'rule_limit' });
    expect(await ruleCount(location)).toBe(30);
    const actions = (await auditEvents(server)).filter((e) => (e.details as { locationId?: string }).locationId === location).map((e) => e.action);
    expect(actions).toEqual(['rule.created']);
  });

  it('two adds racing at 29 rules that both recount before either reverts both answer rule_limit, never leaving 31', async () => {
    const location = await addLocation(server, { orgId, name: 'Tie Room' });
    await seedRules(location, 29);
    const counts = hold('countDocuments');
    const deletes = hold('deleteOne');
    const first = add(location, 'First racer');
    await counts.arrived(1);
    const second = add(location, 'Second racer');
    await counts.arrived(2);                // both limit checks see 29
    counts.release(1);
    counts.release(2);
    await counts.arrived(3);
    await counts.arrived(4);                // both have written before either recounts: 31 rows
    counts.open();                          // both recount 31
    await deletes.arrived(1);
    await deletes.arrived(2);               // both revert
    deletes.open();
    for (const res of await Promise.all([first, second])) expect(await errorOf(res)).toEqual({ status: 409, error: 'rule_limit' });
    expect(await ruleCount(location)).toBe(29);
    expect((await auditEvents(server)).filter((e) => (e.details as { locationId?: string }).locationId === location)).toEqual([]);
  });
});

describe('reach', () => {
  it('another location’s or organization’s location or rule id is 404', async () => {
    const location = await addLocation(server, { orgId, name: 'Home Room' });
    const sibling = await addLocation(server, { orgId, name: 'Sibling Room' });
    const rule = await added(location, 'Closed Mondays');
    expect(await errorOf(await edit(sibling, rule.id, 'Closed Sundays', admin))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await remove(sibling, rule.id, admin))).toEqual({ status: 404, error: 'not_found' });
    expect((await listed(sibling, admin)).rules).toEqual([]);

    const otherOrg = await createOrg(server, { name: 'Other Rules Tavern' });
    const otherLocation = await addLocation(server, { orgId: otherOrg, name: 'Other Room' });
    const outsider = await person('outsider', 'org_admin', otherOrg);
    const foreign = await added(otherLocation, 'Sentinel foreign rule', outsider);
    for (const res of [
      await call(server, rulesPath(otherLocation), { session: admin.session }),
      await add(otherLocation, 'Closed Tuesdays', admin),
      await edit(otherLocation, foreign.id, 'Changed', admin),
      await remove(otherLocation, foreign.id, admin),
      await edit(location, foreign.id, 'Changed', admin),
      await remove(location, foreign.id, admin),
    ]) {
      const text = await res.text();
      expect(res.status).toBe(404);
      expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
      expect(text).not.toContain('Sentinel');
    }
    expect((await listed(otherLocation, outsider)).rules.map((r) => r.text)).toEqual(['Sentinel foreign rule']);
  });
});

describe('staff', () => {
  afterEach(async () => {
    await removeStaffFactor(server);
    await server.connection.collection('tw_view_as_grants').deleteMany({});
  });

  it('staff in view-as list rules and are refused every write with 403 view_as_read_only', async () => {
    const location = await addLocation(server, { orgId, name: 'Viewed Room' });
    const rule = await added(location, 'Closed Mondays');
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: author.session.userId, orgId });
    const viewer = { session: staff, email: author.email };
    expect(await listed(location, viewer)).toEqual(await listed(location, author));
    expect(await errorOf(await add(location, 'Closed Tuesdays', viewer))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await errorOf(await edit(location, rule.id, 'Closed Tuesdays', viewer))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await errorOf(await remove(location, rule.id, viewer))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect((await listed(location)).rules.map((r) => r.text)).toEqual(['Closed Mondays']);
  });

  it('staff open as admin add a rule shown as Townwise staff and listed on staff activity', async () => {
    const setupOrg = await createOrg(server, { name: 'Setup Rules Cafe' });
    const location = await addLocation(server, { orgId: setupOrg, name: 'Setup Room' });
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: setupOrg });
    const viaStaff = { session: staff, email: 'unused' };
    const rule = await added(location, 'Closed Mondays', viaStaff);
    expect(rule).toMatchObject({ createdByEmail: 'Townwise staff', canEdit: true, addedVia: 'page' });
    const stored = await server.connection.collection('tw_business_rules').findOne({ _id: new Types.ObjectId(rule.id) });
    expect(stored).toMatchObject({ byStaff: true, createdBy: staff.userId });
    expect((await edit(location, rule.id, 'Closed Mondays all winter', viaStaff)).status).toBe(200);
    // The owner joins (which ends the grant) and reads what staff left.
    const owner = await person('owner', 'org_admin', setupOrg);
    expect((await listed(location, owner)).rules.map((r) => [r.createdByEmail, r.canEdit])).toEqual([['Townwise staff', true]]);

    const event = (await auditEvents(server)).find((e) => e.action === 'rule.created' && (e.target as { id: string }).id === rule.id);
    expect(event).toMatchObject({ actorRole: 'superadmin', actorUserId: staff.userId });
    const activity = await call(server, '/api/org/staff-activity', { session: owner.session });
    const summaries = (await activity.json() as { events: { summary: string }[] }).events.map((e) => e.summary);
    expect(summaries).toEqual(expect.arrayContaining(['Added a business rule', 'Edited a business rule']));
  });
});

describe('deletion', () => {
  afterEach(async () => { await removeStaffFactor(server); });

  it('deleting the location deletes its rules; deleting the organization deletes them too', async () => {
    const location = await addLocation(server, { orgId, name: 'Doomed Room' });
    const kept = await addLocation(server, { orgId, name: 'Kept Room' });
    await added(location, 'Closed Mondays');
    await added(kept, 'Closed Mondays');
    // Rules don't block deleting a location.
    expect((await call(server, `/api/org/locations/${location}`, { method: 'DELETE', session: admin.session })).status).toBe(204);
    expect(await ruleCount(location)).toBe(0);
    expect(await ruleCount(kept)).toBe(1);

    const paused = await createOrg(server, { name: 'Paused Rules Grill', status: 'suspended' });
    const pausedLocation = await addLocation(server, { orgId: paused, name: 'Paused Room' });
    await seedRules(pausedLocation, 3, paused);
    const staff = await signInStaff(server);
    expect((await call(server, `/api/admin/orgs/${paused}`, { method: 'DELETE', session: staff })).status).toBe(200);
    expect(await server.connection.collection('tw_business_rules').countDocuments({ orgId: new Types.ObjectId(paused) })).toBe(0);
    expect(await ruleCount(kept)).toBe(1);
  });
});
