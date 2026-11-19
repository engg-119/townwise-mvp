// The forecast lab's data layer (stores/calibrations.ts and its neighbors): one live calibration per location, the
// callback lookup and the result token that dies with the calibration, compare-and-set transitions, tenant scoping,
// deletion before runs, lab runs in the forecast store, the forecasts switch and the audit wording. The fixture's
// numbers are synthetic.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForLabCallback, scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { summaryOf } from '../src/audit.ts';
import { checkLabRunFile, runFileSha256, type LabRunFile } from '../src/forecasts/file.ts';
import { runView } from '../src/forecasts/reader.ts';
import type { Cause } from '../src/lab/causes.ts';
import { createAuditEventStore, type AuditEventInput } from '../src/stores/audit-events.ts';
import { createCalibrationStore, type CalibrationRequester, type CalibrationStore } from '../src/stores/calibrations.ts';
import { deletePersonRecords, findLabCallback } from '../src/stores/cross-tenant.ts';
import { createForecastStore } from '../src/stores/forecasts.ts';
import { createOrgStore } from '../src/stores/orgs.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const ADMIN = { userId: 'admin-0001', role: 'org_admin', via: 'chat' } as const;
const SYSTEM = { userId: null, role: 'system', via: 'scheduled' } as const;

let server: TownwiseTestServer;
let calibrations: CalibrationStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  calibrations = createCalibrationStore(server.connection);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.connection.collection('tw_calibrations').deleteMany({}); });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Lab Cafe ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

async function queue(t: Tenant, opts: { locationId?: string; minutes?: number } = {}) {
  const now = server.clock.now();
  return calibrations.insertQueued(t.scope, {
    id: new Types.ObjectId().toHexString(), locationId: opts.locationId ?? t.locationId, requestedBy: ADMIN, regimeStart: null,
    championRunId: null, tokenExpiresAt: new Date(now.getTime() + (opts.minutes ?? 20) * 60_000), now,
  });
}

async function queued(t: Tenant) {
  const record = await queue(t);
  if (record === null) throw new Error('slot was taken');
  return record;
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

describe('calibrations', () => {
  it('allows one live calibration per location: a second insertQueued resolves null until the first finishes', async () => {
    const t = await tenant();
    const first = await queued(t);
    expect(await queue(t)).toBeNull();
    expect((await calibrations.live(t.scope, t.locationId))?.id).toBe(first.id);
    const other = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    expect(await queue(t, { locationId: other })).not.toBeNull();
    expect(await calibrations.finish(t.scope, first.id, { status: 'failed', failure: 'start_failed' }, server.clock.now())).toBe(true);
    expect(await calibrations.live(t.scope, t.locationId)).toBeNull();
    expect(await queue(t)).not.toBeNull();
  });

  it('stores the weekly refresh’s requester: no person, role system, via scheduled (D42)', async () => {
    const t = await tenant();
    const now = server.clock.now();
    const record = await calibrations.insertQueued(t.scope, {
      id: new Types.ObjectId().toHexString(), locationId: t.locationId, requestedBy: { userId: null, role: 'system', via: 'scheduled' },
      regimeStart: null, championRunId: null, tokenExpiresAt: new Date(now.getTime() + 20 * 60_000), now,
    });
    expect(record?.requestedBy).toEqual({ userId: null, role: 'system', via: 'scheduled' });
    expect((await calibrations.find(t.scope, record?.id ?? ''))?.requestedBy).toEqual({ userId: null, role: 'system', via: 'scheduled' });
  });

  // D65 (openspec change forecast-training-status, design decision 5): what started a system calibration.
  it('stores a system start’s causes; a person’s start and an empty list store no causes key; an unknown cause throws', async () => {
    const t = await tenant();
    const insert = (causes: readonly Cause[] | undefined, requestedBy: CalibrationRequester = SYSTEM) => {
      const now = server.clock.now();
      return calibrations.insertQueued(t.scope, {
        id: new Types.ObjectId().toHexString(), locationId: t.locationId, requestedBy, causes, regimeStart: null, championRunId: null,
        tokenExpiresAt: new Date(now.getTime() + 20 * 60_000), now,
      });
    };
    const raw = (id: string) => server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(id) });
    const done = (id: string) => calibrations.finish(t.scope, id, { status: 'failed', failure: 'job_failed' }, server.clock.now());

    const system = await insert(['sales', 'person_change']);
    expect(system?.causes).toEqual(['sales', 'person_change']);
    expect((await calibrations.find(t.scope, system?.id ?? ''))?.causes).toEqual(['sales', 'person_change']);
    expect((await raw(system?.id ?? ''))?.causes).toEqual(['sales', 'person_change']);
    await done(system?.id ?? '');

    // A person's start passes none (lab/service.ts): no key despite minimize false, and it reads [].
    const person = await queued(t);
    expect(await raw(person.id)).not.toHaveProperty('causes');
    expect(person.causes).toEqual([]);
    await done(person.id);

    // An empty list is never refused and stores no key either (a refit of a mark from before D65).
    const empty = await insert([]);
    expect(empty).not.toBeNull();
    expect(await raw(empty?.id ?? '')).not.toHaveProperty('causes');
    expect((await calibrations.find(t.scope, empty?.id ?? ''))?.causes).toEqual([]);
    await done(empty?.id ?? '');

    await expect(insert(['bogus' as Cause])).rejects.toThrow();
    expect(await calibrations.live(t.scope, t.locationId)).toBeNull();
  });

  it('insertQueued stores no token: the result token’s hash arrives with the input fetch', async () => {
    const t = await tenant();
    const record = await queued(t);
    const raw = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(record.id) });
    expect(raw).not.toHaveProperty('tokenSha256');
    expect(raw?.tokenExpiresAt).toEqual(new Date(server.clock.now().getTime() + 20 * 60_000));
  });

  it('finish clears liveLocation and the result token hash, so findLabCallback then resolves null', async () => {
    const t = await tenant();
    const record = await queued(t);
    const now = server.clock.now();
    expect((await findLabCallback(server.connection, record.id, now, null))?.calibrationId).toBe(record.id);
    expect(await calibrations.markRunning(t.scope, record.id, { now, imageDigest: null })).toBe(true);
    const input = { inputSha256: sha('input'), dataSha256: sha('data-input'), dataThrough: '2026-04-30', termsThrough: null, resultTokenSha256: sha('result-a') };
    expect(await calibrations.recordInput(t.scope, record.id, input)).toBe(true);
    expect(await calibrations.finish(t.scope, record.id, { status: 'succeeded' }, now)).toBe(true);
    const raw = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(record.id) });
    expect(raw).not.toHaveProperty('liveLocation');
    expect(raw).not.toHaveProperty('tokenSha256');
    expect(await findLabCallback(server.connection, record.id, now, null)).toBeNull();
    expect(await findLabCallback(server.connection, record.id, now, sha('result-a'))).toBeNull();
    // A finished calibration cannot finish again.
    expect(await calibrations.finish(t.scope, record.id, { status: 'failed', failure: 'timeout' }, now)).toBe(false);
  });

  it('findLabCallback needs the id, a live status and an open window, and the result token hash when one is given', async () => {
    const t = await tenant();
    const record = await queued(t);
    const other = await tenant();
    const otherRecord = await queued(other);
    const now = server.clock.now();
    // Without a result token (the input fetch): any live calibration by its id, in its own organization's scope.
    const claim = await findLabCallback(server.connection, record.id, now, null);
    expect(claim).toEqual({ calibrationId: record.id, orgId: t.orgId, locationId: t.locationId });
    expect(claim === null ? null : scopeForLabCallback(claim).orgId).toBe(t.orgId);
    expect((await findLabCallback(server.connection, otherRecord.id, now, null))?.orgId).toBe(other.orgId);
    expect(await findLabCallback(server.connection, 'not-an-id', now, null)).toBeNull();
    expect(await findLabCallback(server.connection, `${record.id}0`, now, null)).toBeNull();
    expect(await findLabCallback(server.connection, new Types.ObjectId().toHexString(), now, null)).toBeNull();
    expect(await findLabCallback(server.connection, record.id, new Date(now.getTime() + 21 * 60_000), null)).toBeNull();
    // With one (the result post): only once the input fetch recorded that hash, and only for that calibration.
    expect(await findLabCallback(server.connection, record.id, now, sha('result-a'))).toBeNull();
    await calibrations.markRunning(t.scope, record.id, { now, imageDigest: null });
    expect(await calibrations.recordInput(t.scope, record.id, { inputSha256: sha('input'), dataSha256: sha('data-input'), dataThrough: '2026-04-30', termsThrough: null, resultTokenSha256: sha('result-a') }))
      .toBe(true);
    expect((await findLabCallback(server.connection, record.id, now, sha('result-a')))?.calibrationId).toBe(record.id);
    expect(await findLabCallback(server.connection, record.id, now, sha('wrong'))).toBeNull();
    expect(await findLabCallback(server.connection, otherRecord.id, now, sha('result-a'))).toBeNull();
    expect(await findLabCallback(server.connection, record.id, new Date(now.getTime() + 21 * 60_000), sha('result-a'))).toBeNull();
  });

  it('recordResult is a compare-and-set on running and keeps a runId once set', async () => {
    const t = await tenant();
    const record = await queued(t);
    const now = server.clock.now();
    const result = { runId: new Types.ObjectId().toHexString(), scorecardJson: '{"a":1}', codeVersion: 'abc1234' };
    // Not running yet.
    expect(await calibrations.recordResult(t.scope, record.id, result)).toBe(false);
    await calibrations.markRunning(t.scope, record.id, { now, imageDigest: 'sha256:abc' });
    const input = { inputSha256: sha('input'), dataSha256: sha('data-input'), dataThrough: '2026-04-30', termsThrough: null, resultTokenSha256: sha('result-a') };
    expect(await calibrations.recordInput(t.scope, record.id, input)).toBe(true);
    expect(await calibrations.recordResult(t.scope, record.id, result)).toBe(true);
    expect(await calibrations.recordResult(t.scope, record.id, { ...result, runId: new Types.ObjectId().toHexString() })).toBe(false);
    const kept = await calibrations.find(t.scope, record.id);
    expect(kept).toMatchObject({ runId: result.runId, scorecardJson: '{"a":1}', codeVersion: 'abc1234', status: 'running', imageDigest: 'sha256:abc' });
    expect(await calibrations.markRunning(t.scope, record.id, { now, imageDigest: null })).toBe(false);
  });

  it('recordInput is the one input fetch: it needs running and no input yet, and sets the result token hash', async () => {
    const t = await tenant();
    const record = await queued(t);
    const now = server.clock.now();
    const input = { inputSha256: sha('input'), dataSha256: sha('data-input'), dataThrough: '2026-04-30', termsThrough: '2028-06-06', resultTokenSha256: sha('result-a') };
    // Not running yet.
    expect(await calibrations.recordInput(t.scope, record.id, input)).toBe(false);
    expect(await calibrations.markRunning(t.scope, record.id, { now, imageDigest: null })).toBe(true);
    // findLabCallback resolves a running calibration.
    expect((await findLabCallback(server.connection, record.id, now, null))?.calibrationId).toBe(record.id);
    expect(await calibrations.recordInput(t.scope, record.id, input)).toBe(true);
    // The fingerprint (D42) is recorded with the input's hash, on every calibration
    expect(await calibrations.find(t.scope, record.id)).toMatchObject({ inputSha256: sha('input'), dataSha256: sha('data-input') });
    // The result token works; a second fetch, whatever it brings, changes nothing.
    expect((await findLabCallback(server.connection, record.id, now, sha('result-a')))?.calibrationId).toBe(record.id);
    expect(await calibrations.recordInput(t.scope, record.id, { ...input, inputSha256: sha('other') })).toBe(false);
    expect(await calibrations.recordInput(t.scope, record.id, {
      inputSha256: sha('other'), dataSha256: sha('data-other'), dataThrough: '2026-05-01', termsThrough: null, resultTokenSha256: sha('result-b'),
    })).toBe(false);
    expect(await findLabCallback(server.connection, record.id, now, sha('result-b'))).toBeNull();
    expect(await calibrations.find(t.scope, record.id)).toMatchObject({
      inputSha256: sha('input'), dataSha256: sha('data-input'), dataThrough: '2026-04-30', termsThrough: '2028-06-06',
    });
  });

  it('termsThrough (D52) is stored with the input, and absent on a calibration whose input was never fetched', async () => {
    const t = await tenant();
    const record = await queued(t);
    expect(record.termsThrough).toBeNull();
    const collection = server.connection.collection('tw_calibrations');
    expect(await collection.findOne({ _id: new Types.ObjectId(record.id) })).not.toHaveProperty('termsThrough');
    expect((await calibrations.find(t.scope, record.id))?.termsThrough).toBeNull();
    await calibrations.markRunning(t.scope, record.id, { now: server.clock.now(), imageDigest: null });
    expect(await calibrations.recordInput(t.scope, record.id, {
      inputSha256: sha('input'), dataSha256: sha('data-input'), dataThrough: '2026-04-30', termsThrough: null, resultTokenSha256: sha('result-a'),
    })).toBe(true);
    // A town with no researched terms: stored as null
    expect(await collection.findOne({ _id: new Types.ObjectId(record.id) })).toHaveProperty('termsThrough', null);
    expect((await calibrations.find(t.scope, record.id))?.termsThrough).toBeNull();
  });

  it('recordImageDigest records the image once, on a running calibration with none', async () => {
    const t = await tenant();
    const record = await queued(t);
    expect(await calibrations.recordImageDigest(t.scope, record.id, 'sha256:aaa')).toBe(false);
    await calibrations.markRunning(t.scope, record.id, { now: server.clock.now(), imageDigest: null });
    expect(await calibrations.recordImageDigest(t.scope, record.id, 'sha256:aaa')).toBe(true);
    expect(await calibrations.recordImageDigest(t.scope, record.id, 'sha256:bbb')).toBe(false);
    expect((await calibrations.find(t.scope, record.id))?.imageDigest).toBe('sha256:aaa');
  });

  it('finish succeeded needs running: a queued calibration only fails', async () => {
    const t = await tenant();
    const record = await queued(t);
    expect(await calibrations.finish(t.scope, record.id, { status: 'succeeded' }, server.clock.now())).toBe(false);
    expect((await calibrations.find(t.scope, record.id))?.status).toBe('queued');
    expect(await calibrations.finish(t.scope, record.id, { status: 'failed', failure: 'timeout' }, server.clock.now())).toBe(true);
  });

  it('recordGate sets the gate once; a second call resolves false', async () => {
    const t = await tenant();
    const record = await queued(t);
    await calibrations.markRunning(t.scope, record.id, { now: server.clock.now(), imageDigest: null });
    expect(await calibrations.recordGate(t.scope, record.id, { published: false, reason: 'not_better' })).toBe(true);
    expect(await calibrations.recordGate(t.scope, record.id, { published: true, reason: 'better' })).toBe(false);
    expect((await calibrations.find(t.scope, record.id))?.gate).toEqual({ published: false, reason: 'not_better' });
    expect(await calibrations.setCharge(t.scope, record.id, 100_000)).toBe(true);
    expect((await calibrations.find(t.scope, record.id))?.chargedMicroUsd).toBe(100_000);
  });

  it('every store function filters on scope.orgId: another org reads null and changes nothing', async () => {
    const t = await tenant();
    const other = await tenant();
    const record = await queued(t);
    const now = server.clock.now();
    await calibrations.markRunning(t.scope, record.id, { now, imageDigest: null });
    const before = JSON.stringify(await server.connection.collection('tw_calibrations').find({}).sort({ _id: 1 }).toArray());
    expect(await calibrations.find(other.scope, record.id)).toBeNull();
    expect(await calibrations.live(other.scope, t.locationId)).toBeNull();
    expect(await calibrations.list(other.scope, 10)).toEqual([]);
    expect(await calibrations.list(other.scope, 10, t.locationId)).toEqual([]);
    expect(await calibrations.markRunning(other.scope, record.id, { now, imageDigest: null })).toBe(false);
    expect(await calibrations.recordInput(other.scope, record.id, {
      inputSha256: sha('x'), dataSha256: sha('data-x'), dataThrough: '2026-04-30', termsThrough: null, resultTokenSha256: sha('result-x'),
    })).toBe(false);
    expect(await calibrations.recordImageDigest(other.scope, record.id, 'sha256:other')).toBe(false);
    expect(await calibrations.recordResult(other.scope, record.id, { runId: 'r', scorecardJson: '{}', codeVersion: 'c' })).toBe(false);
    expect(await calibrations.recordGate(other.scope, record.id, { published: true, reason: 'x' })).toBe(false);
    expect(await calibrations.setCharge(other.scope, record.id, 5)).toBe(false);
    expect(await calibrations.finish(other.scope, record.id, { status: 'succeeded' }, now)).toBe(false);
    expect(await calibrations.removeForLocation(other.scope, t.locationId)).toBe(0);
    expect(await calibrations.removeForOrg(other.scope)).toBe(0);
    expect(JSON.stringify(await server.connection.collection('tw_calibrations').find({}).sort({ _id: 1 }).toArray())).toBe(before);
    expect((await calibrations.list(t.scope, 10)).map((each) => each.id)).toEqual([record.id]);
  });

  it('removeForLocation and removeForOrg delete calibrations; deleting sales, a location or an org deletes them before their runs', async () => {
    const t = await tenant();
    const second = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    await queued(t);
    await queue(t, { locationId: second });
    expect(await calibrations.removeForLocation(t.scope, t.locationId)).toBe(1);
    expect(await calibrations.removeForOrg(t.scope)).toBe(1);
    expect(await count('tw_calibrations', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    // The source calls them first in each deletion path (the org path is pinned in deletion.int.test.ts).
    for (const [path, order] of [
      ['../src/handlers/locations.ts', ['calibrations.removeForLocation', 'forecasts.removeForLocation']],
      ['../src/handlers/sales.ts', ['calibrations.removeForLocation', 'forecasts.removeForLocation']],
      ['../src/handlers/deletion.ts', ['calibrations.removeForOrg', 'forecasts.removeForOrg']],
    ] as const) {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(text.indexOf(order[0])).toBeGreaterThan(-1);
      expect(text.indexOf(order[0])).toBeLessThan(text.indexOf(order[1]));
    }
  });

  it('person deletion nulls requestedBy.userId', async () => {
    const t = await tenant();
    const record = await queued(t);
    await deletePersonRecords(server.connection, { userId: ADMIN.userId, email: 'gone@example.test' });
    expect((await calibrations.find(t.scope, record.id))?.requestedBy).toEqual({ userId: null, role: 'org_admin', via: 'chat' });
  });
});

describe('lab runs, the forecasts switch and the audit words', () => {
  const labFile = (): Record<string, unknown> => ({ ...structuredClone(FIXTURE), trainingSource: 'townwise_lab', frozen: null });

  it('upsertRun stores a lab run with its lab block and importedBy null; runView reads trainingSource townwise_lab', async () => {
    const t = await tenant();
    const forecasts = createForecastStore(server.connection);
    const check = checkLabRunFile(labFile(), '2026-06-01');
    expect(check.ok).toBe(true);
    const file = (check as { file: LabRunFile }).file;
    const lab = { calibrationId: new Types.ObjectId().toHexString(), codeVersion: 'abc1234', imageDigest: null, inputSha256: sha('in'), paramsJson: '{"n":1}' };
    const id = new Types.ObjectId().toHexString();
    const { run, inserted } = await forecasts.upsertRun(t.scope, t.locationId, {
      id, file, fileSha256: runFileSha256(file), importedBy: null, lab, now: server.clock.now(),
    });
    expect(inserted).toBe(true);
    expect(run).toMatchObject({ id, trainingSource: 'townwise_lab', importedBy: null, frozen: false, lab });
    expect(runView(run).trainingSource).toBe('townwise_lab');
    expect((await forecasts.find(t.scope, id))?.lab).toEqual(lab);
  });

  it('setForecasts switches on and off; an org document without the field reads { on: true, at: null } (D42)', async () => {
    const t = await tenant();
    const orgs = createOrgStore(server.connection);
    expect((await orgs.findById(t.orgId))?.forecasts).toEqual({ on: true, at: null });
    const on = server.clock.now();
    expect(await orgs.setForecasts(t.scope, { on: true, at: on, by: 'staff-0000' })).toBe(true);
    expect((await orgs.findById(t.orgId))?.forecasts).toEqual({ on: true, at: on });
    const off = new Date(on.getTime() + 1000);
    expect(await orgs.setForecasts(t.scope, { on: false, at: off, by: 'staff-0000' })).toBe(true);
    expect((await orgs.findById(t.orgId))?.forecasts).toEqual({ on: false, at: off });
    expect(await orgs.setForecasts(scopeForNewOrg(STAFF, new Types.ObjectId().toHexString()), { on: true, at: on, by: 's' })).toBe(false);
  });

  it('person deletion nulls the staff id on the forecasts switch and leaves it on', async () => {
    const t = await tenant();
    const orgs = createOrgStore(server.connection);
    const at = server.clock.now();
    expect(await orgs.setForecasts(t.scope, { on: true, at, by: 'staff-gone' })).toBe(true);
    await deletePersonRecords(server.connection, { userId: 'staff-gone', email: 'gone@example.test' });
    const doc = await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(t.orgId) });
    expect(doc?.forecasts).toEqual({ on: true, at, by: null });
    expect((await orgs.findById(t.orgId))?.forecasts).toEqual({ on: true, at });
  });

  it('an audit query by several actor roles returns each of them and no other', async () => {
    const t = await tenant();
    const audit = createAuditEventStore(server.connection);
    const event = (actorRole: AuditEventInput['actorRole'], minutes: number): AuditEventInput => ({
      actorUserId: `${actorRole}-0001`, actorEmail: `${actorRole}@example.test`, actorRole, viewAsGrantId: null,
      at: new Date(server.clock.now().getTime() + minutes * 60_000), orgId: t.orgId, action: 'org.forecasts_switched',
      target: { type: 'org', id: t.orgId }, details: { on: true },
    });
    for (const [role, minutes] of [['superadmin', 1], ['system', 2], ['org_admin', 3]] as const) await audit.insert(event(role, minutes));
    const page = await audit.query({ orgId: t.orgId, actorRole: ['superadmin', 'system'], limit: 10 });
    expect(page.events.map((each) => each.actorRole)).toEqual(['system', 'superadmin']);
    expect((await audit.query({ orgId: t.orgId, actorRole: 'org_admin', limit: 10 })).events).toHaveLength(1);
  });

  it('summaryOf words the new actions', () => {
    expect(summaryOf('calibration.requested', { hasRegime: true })).toBe('Started a calibration, with a weekly pattern change');
    expect(summaryOf('calibration.requested', { hasRegime: false })).toBe('Started a calibration');
    expect(summaryOf('calibration.finished', { status: 'failed', gate: null })).toBe('A calibration failed');
    expect(summaryOf('calibration.finished', { status: 'succeeded', gate: 'published' })).toBe('A calibration published a new forecast');
    expect(summaryOf('calibration.finished', { status: 'succeeded', gate: 'draft' })).toBe('A calibration made a draft forecast');
    expect(summaryOf('org.forecasts_switched', { on: true })).toBe('Switched forecasts on, with the owner’s agreement');
    expect(summaryOf('org.forecasts_switched', { on: false })).toBe('Switched forecasts off');
    expect(summaryOf('forecast.published', { via: 'lab', modelVersion: 'v9', from: '2026-05-01', to: '2026-05-14' }))
      .toBe('Published a calibrated forecast (model v9) for 2026-05-01 to 2026-05-14');
    expect(summaryOf('forecast.published', { modelVersion: 'v9', from: '2026-05-01', to: '2026-05-14' }))
      .toBe('Published a forecast (model v9) for 2026-05-01 to 2026-05-14');
  });
});
