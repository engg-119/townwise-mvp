// Staff suppression of a shared town row (D66, design decision 9, scripts/research-suppress.ts): the arguments refuse
// a missing staff id, an unlisted email, a location row's id and a free-text code; a suppression marks the row, writes
// research.town_event_suppressed with ids only, and every location's read leaves the row out. Synthetic rows only.
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSuppressArgs, suppressTownEvent } from '../scripts/research-suppress.ts';
import { scopeForNewOrg } from '../src/access/policy.ts';
import { readResearchedViews } from '../src/research/read.ts';
import { addLocation, auditEvents, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const HEX = '0123456789abcdef01234567';
const EMAILS = ['staff@example.test'];

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

describe('the arguments', () => {
  it('take a town of the twelve, a town event id, a short code, the staff id and a listed email', () => {
    expect(parseSuppressArgs(['hanover-nh', `t-${HEX}`, 'wrong_date', 'staff-0000', 'Staff@Example.test'], EMAILS)).toEqual({
      townKey: 'hanover-nh', eventHex: HEX, code: 'wrong_date', staffUserId: 'staff-0000', staffEmail: 'staff@example.test',
    });
    expect(parseSuppressArgs(['hanover-nh', HEX, 'harmful', 'staff-0000', 'staff@example.test'], EMAILS)).toMatchObject({ eventHex: HEX });
  });

  it('refuse anything else, a missing staff id or an unlisted email above all', () => {
    for (const argv of [
      ['nowhere-xx', `t-${HEX}`, 'wrong_date', 'staff-0000', 'staff@example.test'],
      ['hanover-nh', `l-${HEX}`, 'wrong_date', 'staff-0000', 'staff@example.test'],
      ['hanover-nh', `t-${HEX}`, 'Wrong date, ask Pat', 'staff-0000', 'staff@example.test'],
      ['hanover-nh', `t-${HEX}`, 'wrong_date', '', 'staff@example.test'],
      ['hanover-nh', `t-${HEX}`, 'wrong_date', 'staff-0000'],
      ['hanover-nh', `t-${HEX}`, 'wrong_date', 'staff-0000', 'someone@example.test'],
    ]) expect(typeof parseSuppressArgs(argv, EMAILS)).toBe('string');
  });
});

describe('a suppression', () => {
  it('marks the row, audits ids only, and every location’s read leaves it out; an unknown row changes nothing', async () => {
    const run = new Types.ObjectId().toHexString();
    const at = server.clock.now();
    const row = await server.ctx.stores.researchTowns.insertEvent('hanover-nh', {
      title: 'Sentinel Wrong Fair', titleKey: 'sentinel wrong fair', kind: 'event', category: 'festival', start: '2026-12-05', end: '2026-12-05',
      weekdays: null, startTime: null, status: 'scheduled', venueId: null, hostId: null, confidence: 'high',
      sources: [{ label: 'News', url: 'https://news.example/fair' }], firstRunId: run, lastRunId: run, firstSeenAt: at, lastSeenAt: at, seenCount: 1,
    });
    const orgId = await createOrg(server, { name: 'Suppress Cafe' });
    const scope = scopeForNewOrg(STAFF, orgId);
    const locationId = await addLocation(server, { orgId, name: 'Main Room' });
    const location = await server.ctx.stores.locations.find(scope, locationId);
    if (location === null) throw new Error('no location');
    const ids = async () => (await readResearchedViews(server.ctx, scope, location, null)).map((view) => view.id);
    expect(await ids()).toContain(`t-${row.id}`);

    const input = { townKey: 'hanover-nh', eventHex: row.id, code: 'wrong_date', staffUserId: 'staff-0000', staffEmail: 'staff@example.test' } as const;
    expect(await suppressTownEvent({ stores: server.ctx.stores, now: () => at }, input)).toBe(true);
    expect((await server.ctx.stores.researchTowns.events('hanover-nh')).find((event) => event.id === row.id)?.suppressed).toEqual({ at, code: 'wrong_date' });
    expect(await ids()).not.toContain(`t-${row.id}`);
    const events = (await auditEvents(server)).filter((event) => event.action === 'research.town_event_suppressed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorRole: 'superadmin', orgId: null, target: { type: 'research_event', id: `t-${row.id}` },
      details: { townKey: 'hanover-nh', eventId: `t-${row.id}`, code: 'wrong_date' },
    });
    expect(JSON.stringify(events[0])).not.toContain('Sentinel');

    expect(await suppressTownEvent({ stores: server.ctx.stores, now: () => at }, { ...input, eventHex: HEX })).toBe(false);
    expect((await auditEvents(server)).filter((event) => event.action === 'research.town_event_suppressed')).toHaveLength(1);
  });
});
