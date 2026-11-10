// The forecast lab's three TownwiseAI tools through a real chat turn (scripted model, helpers/chat-model.ts) and the lab's
// own job callback (helpers/lab.ts): the org-admin rule, starting a calibration (its event after the effect, its
// refusals in words, with and without a lab runner), reading its scorecard as components, comparing it with the published
// forecast, and results and cards with no parameters, code version, input hash, token, draft forecast day or date after
// the data. Every number is synthetic.
import { randomUUID } from 'node:crypto';

import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NEXT_STEPS } from '../src/lab/components.ts';
import { GATE_WORDS } from '../src/lab/gate.ts';
import { labInputSchema, type LabInput } from '../src/lab/input.ts';
import { LabStartError } from '../src/lab/runner.ts';
import { FAILURE_WORDS, START_REFUSAL_WORDS } from '../src/lab/service.ts';
import { addInvite, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, scriptedModel, text, toolUse, type ScriptedModel, type Step, type UsageInput } from './helpers/chat-model.ts';
import {
  CODE_VERSION, failJob, fakeLabRunner, jobCall, labResultFor, resultTokenOf, runDays, seedHistory, type FakeLabRunner,
} from './helpers/lab.ts';
import { comparisonWith, scorecardWith } from './helpers/lab-scorecard.ts';
import { call, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let model: ScriptedModel;
let runner: FakeLabRunner;
let staff: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  runner = fakeLabRunner();
  server = await startTownwiseServer({ chat: model, labRunner: runner });
  staff = await signInStaff(server);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_chat_usage').deleteMany({});
  model.calls.length = 0;
  runner.onStart = null;
});

interface Team { orgId: string; locationId: string; admin: TestSession; member: TestSession }
interface Job { calibrationId: string }
interface Reply { result: Record<string, unknown>; raw: string; views: { input: unknown; result: unknown }[]; isError: boolean }

async function seat(orgId: string, role: 'org_admin' | 'member', on = server): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(on, email);
  await addSeat(on, { orgId, userId: session.userId, email, role });
  return session;
}

/** An organization with an org admin, a member and a Hanover location holding guests from `from` to 2026-05-31. */
async function team(from = '2024-10-01'): Promise<Team> {
  const orgId = await createOrg(server, { name: `Lab Chat ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
  await seedHistory(server, { orgId, locationId, from, to: '2026-05-31' });
  return { orgId, locationId, admin: await seat(orgId, 'org_admin'), member: await seat(orgId, 'member') };
}

function toolResultsOf(param: BetaMessageParam | undefined): BetaToolResultBlockParam[] {
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return [];
  return param.content.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
}

interface Chat { server: TownwiseTestServer; model: ScriptedModel }

/**
 * One chat turn in which the model calls `name` once; the tool's result, as the turn saved it, and the views its card
 * streamed. With `usage`, that one call costs it: when it spends the month the turn ends after the tool ran, with no
 * second call.
 */
async function ask(t: Team, who: 'admin' | 'member', name: string, input: unknown = {}, opts: { on?: Chat; usage?: UsageInput } = {}): Promise<Reply> {
  const on = opts.on ?? { server, model };
  const id = `toolu_${randomUUID().slice(0, 8)}`;
  const first: Step = { kind: 'message', message: message([toolUse(id, name, input)], opts.usage === undefined ? {} : { usage: opts.usage }) };
  if (opts.usage === undefined) on.model.script(first, { kind: 'message', message: message([text('Done.')]) });
  else on.model.script(first);
  const res = await call(on.server, `/api/org/locations/${t.locationId}/chat/turns`, { session: t[who], json: { content: 'Calibrate' } });
  expect(res.status).toBe(200);
  const events = (await res.text()).split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as Record<string, unknown> }];
  });
  const views = events.flatMap(({ event, data }) => (event !== 'tool' || data.state === 'running' ? [] : [{ input: data.input, result: data.result }]));
  const conversationId = String(events.find(({ event }) => event === 'conversation')?.data.id);
  const doc = await on.server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(conversationId) });
  const saved = (doc?.messages as { param: string }[] | undefined ?? []).map((m) => JSON.parse(m.param) as BetaMessageParam);
  const block = saved.flatMap(toolResultsOf).find((result) => result.tool_use_id === id);
  if (block === undefined || typeof block.content !== 'string') throw new Error('no tool result');
  return { result: JSON.parse(block.content) as Record<string, unknown>, raw: block.content, views, isError: block.is_error === true };
}

async function inputFor(job: Job): Promise<LabInput> {
  const res = await jobCall(server, job, 'input');
  expect(res.status).toBe(200);
  return labInputSchema.parse(await res.json());
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

/** A published run of the location whose forecast reaches 2026-07-09, so it is the current one the calibration beats. */
async function publishedChampion(t: Team): Promise<string> {
  const switchTo = (json: unknown): Promise<Response> => call(server, `/api/admin/orgs/${t.orgId}/forecasts-switch`, { session: staff, json });
  const file = {
    schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v5', notebookCommit: 'abcdef0' },
    trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', frozen: null,
    interval: { level: 0.8, widened: true }, backtest: null, ...runDays('2026-04-30', 70),
  };
  const imported = await call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/forecast-runs`, { session: staff, json: file });
  expect(imported.status).toBe(201);
  const { run } = await imported.json() as { run: { id: string } };
  expect((await switchTo({ on: true, ownerAgreed: true })).status).toBe(200);
  expect((await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}/publish`, { session: staff, json: {} })).status).toBe(200);
  expect((await switchTo({ on: false })).status).toBe(200);
  return run.id;
}

/** Starts one in chat and plays the job: its result is `withComparison` or a first calibration's. */
async function finished(t: Team, withComparison: boolean): Promise<{ calibrationId: string; job: Job }> {
  const started = await ask(t, 'admin', 'start_calibration');
  expect(started.result.started).toBe(true);
  const job = runner.jobs.at(-1);
  if (job === undefined) throw new Error('no job');
  const input = await inputFor(job);
  const weeks = ['2026-03-02', '2026-03-09', '2026-03-16'];
  const scorecard = scorecardWith({
    history: { firstDate: input.days[0]?.date ?? '', lastDate: input.dataThrough },
    backtest: {
      series: weeks.map((week, i) => ({ week, actual: 300 + i, mid: 295.6 + i, low: i === 2 ? null : 250.2, high: i === 2 ? null : 340.1 })),
    },
    comparison: withComparison
      ? {
        // The challenger has a range on fewer of the 13 weeks than the champion (12, the gate's minimum), so the cards
        // carry both counts.
        ...comparisonWith(
          { weeklyWape: 0.2, coverage80: { inside: 11, weeks: 13 } }, { weeklyWape: 0.15, coverage80: { inside: 9, weeks: 12 } }, 13,
        ),
        championRunId: input.champion?.runId ?? '',
        championDataThrough: input.champion?.dataThrough ?? '',
        series: weeks.map((week, i) => ({
          week, actual: 300 + i, champion: 310.4 + i, challenger: 295.6 + i, challengerLow: 250.2, challengerHigh: 340.1,
        })),
      }
      : null,
  });
  expect((await jobCall(server, job, 'result', labResultFor(input, { scorecard }))).status).toBe(200);
  return { calibrationId: job.calibrationId, job };
}

describe('who may calibrate', () => {
  it('a member gets started false / available false with the org-admin words and no calibration starts', async () => {
    const t = await team();
    const jobs = runner.jobs.length;
    const words = 'Only an org admin can calibrate forecasts or see calibrations.';
    const start = await ask(t, 'member', 'start_calibration');
    expect(start.result).toEqual({ started: false, code: 'org_admin_only', message: words });
    expect(await ask(t, 'member', 'get_calibration')).toMatchObject({ result: { available: false, reason: words } });
    expect(await ask(t, 'member', 'compare_forecast_models')).toMatchObject({ result: { available: false, reason: words } });
    expect(runner.jobs).toHaveLength(jobs);
    expect(await count('tw_calibrations', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    expect(start.views).toEqual([{ input: { hasRegimeStart: false }, result: { started: false, status: null, code: 'org_admin_only' } }]);
  });
});

describe('start_calibration', () => {
  it('starts one, records calibration.requested after the effect, and returns 3 suggestedNextSteps', async () => {
    const t = await team();
    const seen: number[] = [];
    runner.onStart = async (job) => {
      seen.push((await auditEvents(server)).filter((event) => (event.details as { calibrationId?: string } | undefined)?.calibrationId === job.calibrationId).length);
    };
    const reply = await ask(t, 'admin', 'start_calibration');
    expect(reply.result).toMatchObject({ started: true, status: 'running', suggestedNextSteps: [...NEXT_STEPS.started] });
    expect(reply.result.suggestedNextSteps).toHaveLength(3);
    const job = runner.jobs.at(-1);
    expect(job?.calibrationId).toBe(reply.result.calibrationId);
    // While the job started the event did not exist yet; afterwards there is one, by the org admin, via chat.
    expect(seen).toEqual([0]);
    const events = (await auditEvents(server)).filter((event) => (event.details as { calibrationId?: string } | undefined)?.calibrationId === job?.calibrationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'calibration.requested', actorRole: 'org_admin', orgId: new Types.ObjectId(t.orgId),
      target: { type: 'calibration', id: job?.calibrationId },
      details: { locationId: t.locationId, calibrationId: job?.calibrationId, via: 'chat', hasRegime: false },
    });
    expect(await count('tw_calibrations', { orgId: new Types.ObjectId(t.orgId), requestedBy: { userId: t.admin.userId, role: 'org_admin', via: 'chat' } })).toBe(1);
    expect(reply.views).toEqual([{ input: { hasRegimeStart: false }, result: { started: true, status: 'running', code: null } }]);
  });

  it('started by staff who have the organization open as admin (D25), it is recorded as staff’s, under the grant', async () => {
    const orgId = await createOrg(server, { name: `Lab Setup ${randomUUID().slice(0, 6)}` });
    await addInvite(server, {
      orgId, email: `first-admin-${randomUUID().slice(0, 8)}@example.test`, invitedBy: staff.userId, role: 'org_admin', addedByStaff: true,
    });
    const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
    await seedHistory(server, { orgId, locationId, from: '2024-10-01', to: '2026-05-31' });
    const grantId = await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId });
    try {
      const reply = await ask({ orgId, locationId, admin: staff, member: staff }, 'admin', 'start_calibration');
      expect(reply.result).toMatchObject({ started: true });
      expect(await count('tw_calibrations', { orgId: new Types.ObjectId(orgId), requestedBy: { userId: staff.userId, role: 'superadmin', via: 'chat' } })).toBe(1);
      const event = (await auditEvents(server)).find((e) => e.action === 'calibration.requested' && String(e.orgId) === orgId);
      expect(event).toMatchObject({ actorRole: 'superadmin', actorUserId: staff.userId, viewAsGrantId: grantId });
    } finally {
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('passes regimeStart and returns START_REFUSAL_WORDS for each refusal', async () => {
    const t = await team();
    const dated = await ask(t, 'admin', 'start_calibration', { regimeStart: '2025-12-01' });
    expect(dated.result.started).toBe(true);
    expect(await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(String(dated.result.calibrationId)) }))
      .toMatchObject({ regimeStart: '2025-12-01' });
    expect(dated.views[0]?.input).toEqual({ hasRegimeStart: true });
    const refusal = async (name: keyof typeof START_REFUSAL_WORDS, who: Team, input: unknown = {}): Promise<void> => {
      const jobs = runner.jobs.length;
      const reply = await ask(who, 'admin', 'start_calibration', input);
      expect(reply.result).toEqual({ started: false, code: name, message: START_REFUSAL_WORDS[name] });
      expect(reply.views[0]?.result).toEqual({ started: false, status: null, code: name });
      expect(runner.jobs).toHaveLength(jobs);
    };
    await refusal('in_progress', t);
    const finishedJob = runner.jobs.at(-1);
    if (finishedJob === undefined) throw new Error('no job');
    expect((await failJob(server, finishedJob)).status).toBe(200);
    // A calibration that failed says why, with three next steps, and its card says it didn't finish.
    const failed = await ask(t, 'admin', 'get_calibration');
    expect(failed.result).toMatchObject({
      available: true, status: 'failed', weeks: null, published: null, failure: FAILURE_WORDS.job_failed, suggestedNextSteps: [...NEXT_STEPS.failed],
    });
    expect(failed.views).toEqual([{ input: null, result: { available: true, status: 'failed', weeks: null, published: null } }]);
    await refusal('invalid_regime_start', t, { regimeStart: '2026-05-20' });
    await refusal('not_enough_history', await team('2024-10-14'));
    const unstarted = await team();
    runner.failNext(new LabStartError('upstream_status', { status: 403 }));
    await refusal('start_failed', unstarted);
    // The job never started, but the calibration exists (failed start_failed), so its request is recorded with its finish.
    const record = await server.connection.collection('tw_calibrations').findOne({ orgId: new Types.ObjectId(unstarted.orgId) });
    expect(record).toMatchObject({ status: 'failed', failure: 'start_failed', requestedBy: { userId: unstarted.admin.userId, via: 'chat' } });
    const trail = (await auditEvents(server)).filter((event) => (event.details as { calibrationId?: string } | undefined)?.calibrationId === record?._id.toHexString());
    expect(trail.map((event) => event.action)).toEqual(expect.arrayContaining(['calibration.requested', 'calibration.finished']));
    expect(trail).toHaveLength(2);
    const [requested, finish] = ['calibration.requested', 'calibration.finished'].map((action) => trail.find((event) => event.action === action));
    expect(requested).toMatchObject({ actorRole: 'org_admin', details: { via: 'chat', hasRegime: false } });
    expect((requested?.at as Date).getTime()).toBeLessThanOrEqual((finish?.at as Date).getTime());
    for (let n = 1; n <= 3; n += 1) {
      const more = await ask(t, 'admin', 'start_calibration');
      expect(more.result.started).toBe(true);
      const job = runner.jobs.at(-1);
      if (job === undefined) throw new Error('no job');
      expect((await failJob(server, job)).status).toBe(200);
    }
    await refusal('rate_limited', t);
  });

  it('refuses budget_exhausted when the model call that asked for it spent the month, and starts nothing', async () => {
    // The turn checks the budget before each later model call, so the tools the spending call asked for still run.
    const t = await team();
    const jobs = runner.jobs.length;
    const now = server.clock.now();
    await server.connection.collection('tw_chat_usage').insertOne({
      orgId: new Types.ObjectId(t.orgId), month: now.toISOString().slice(0, 7), costMicroUsd: 19_990_000, updatedAt: now,
    });
    const reply = await ask(t, 'admin', 'start_calibration', {}, { usage: { input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 } });
    expect(reply.result).toEqual({ started: false, code: 'budget_exhausted', message: START_REFUSAL_WORDS.budget_exhausted });
    expect(reply.views).toEqual([{ input: { hasRegimeStart: false }, result: { started: false, status: null, code: 'budget_exhausted' } }]);
    expect(runner.jobs).toHaveLength(jobs);
    expect(await count('tw_calibrations', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    expect(model.remaining()).toBe(0);
  });
});

describe('get_calibration and compare_forecast_models', () => {
  it('get_calibration returns status, gate words, a line_band_chart of backtest weeks and metric_cards', async () => {
    const t = await team();
    expect(await ask(t, 'admin', 'get_calibration')).toMatchObject({ result: { available: false, reason: 'This location has no calibration yet.' } });
    const { calibrationId } = await finished(t, false);
    const reply = await ask(t, 'admin', 'get_calibration');
    expect(reply.result).toMatchObject({
      available: true, calibrationId, status: 'succeeded', weeks: 12, published: false, gate: GATE_WORDS.forecasts_off,
      suggestedNextSteps: [...NEXT_STEPS.draft],
    });
    const [chart, cards] = reply.result.components as { type: string; title?: string; rows?: unknown[]; series?: unknown[]; band?: unknown; cards?: { label: string }[] }[];
    expect(chart).toMatchObject({
      type: 'line_band_chart', title: 'Held-out weeks: guests and the forecast’s 80% range', unit: 'guests', band: { label: '80% range' },
      series: [{ key: 'actual', label: 'Actual' }, { key: 'mid', label: 'Forecast' }],
      rows: [
        { x: '2026-03-02', actual: 300, mid: 296, low: 250, high: 341, compare: null },
        { x: '2026-03-09', actual: 301, mid: 297, low: 250, high: 341, compare: null },
        { x: '2026-03-16', actual: 302, mid: 298, low: null, high: null, compare: null },
      ],
    });
    expect(cards?.type).toBe('metric_cards');
    expect(cards?.cards?.map((card) => card.label)).toEqual([
      'Weekly error (WAPE)', 'Typical week off by', 'Weeks over 20% off', 'Worst week', '80% range held', 'Weekday bias',
    ]);
    // Counted over the backtest's 12 weeks, with no current forecast beside them.
    expect(cards?.cards?.[2]).toMatchObject({ key: 'weeksOver20', of: 12, compare: null, compareOf: null });
    expect(reply.views).toEqual([{ input: null, result: { available: true, status: 'succeeded', weeks: 12, published: false } }]);
    // A named calibration of another location is not found.
    const other = await team();
    expect(await ask(other, 'admin', 'get_calibration', { calibrationId })).toMatchObject({
      result: { available: false, reason: 'There is no such calibration for this location.' },
    });
    // Nor is one of another location in the same organization.
    const patio: Team = { ...t, locationId: await addLocation(server, { orgId: t.orgId, name: 'Patio' }) };
    for (const name of ['get_calibration', 'compare_forecast_models']) {
      expect(await ask(patio, 'admin', name, { calibrationId })).toMatchObject({
        result: { available: false, reason: 'There is no such calibration for this location.' },
      });
    }
  });

  it('get_calibration on a live calibration says it has not finished', async () => {
    const t = await team();
    await ask(t, 'admin', 'start_calibration');
    const reply = await ask(t, 'admin', 'get_calibration');
    expect(reply.result).toMatchObject({ available: true, status: 'running', suggestedNextSteps: [...NEXT_STEPS.started] });
    expect(reply.result).not.toHaveProperty('components');
  });

  it('compare_forecast_models returns the comparison table and chart, or available false without a comparison', async () => {
    const t = await team();
    await publishedChampion(t);
    const { calibrationId } = await finished(t, true);
    const reply = await ask(t, 'admin', 'compare_forecast_models', { calibrationId });
    expect(reply.result).toMatchObject({
      available: true, calibrationId, status: 'succeeded', weeks: 13, published: false, gate: GATE_WORDS.forecasts_off,
      suggestedNextSteps: [...NEXT_STEPS.compared],
    });
    const [table, chart] = reply.result.components as { type: string; columns?: unknown; rows: { label?: string; current?: string; candidate?: string; compare?: number | null }[] }[];
    expect(table).toMatchObject({ type: 'comparison_table', columns: ['', 'Current forecast', 'New calibration'] });
    expect(table?.rows[0]).toEqual({ label: 'Weekly error (WAPE)', current: '20.0%', candidate: '15.0%' });
    expect(chart).toMatchObject({ type: 'line_band_chart', series: [{ label: 'Actual' }, { label: 'Forecast' }, { label: 'Current forecast' }] });
    expect(chart?.rows[0]).toEqual({ x: '2026-03-02', actual: 300, mid: 296, low: 250, high: 341, compare: 310 });
    expect(reply.views).toEqual([{ input: { calibrationId }, result: { available: true, status: 'succeeded', weeks: 13, published: false } }]);
    // get_calibration's cards put the calibration beside the current forecast, each count with its own weeks.
    const read = await ask(t, 'admin', 'get_calibration', { calibrationId });
    const cards = (read.result.components as { cards?: Record<string, unknown>[] }[])[1]?.cards;
    expect(cards?.find((card) => card.key === 'coverage80')).toEqual({
      key: 'coverage80', label: '80% range held', value: 9, unit: 'count', of: 12, compare: 11, compareOf: 13, better: 'closer_to_80',
    });
    expect(cards?.find((card) => card.key === 'weeksOver20')).toMatchObject({ value: 3, of: 13, compare: 3, compareOf: 13 });

    const first = await team();
    expect(await ask(first, 'admin', 'compare_forecast_models')).toMatchObject({ result: { available: false } });
    await finished(first, false);
    expect(await ask(first, 'admin', 'compare_forecast_models')).toMatchObject({
      result: { available: false, reason: 'There was no published forecast to compare this calibration with.' },
    });
  });
});

describe('what a lab result may carry', () => {
  it('lab tool results never contain params, codeVersion, inputSha256, a token, a draft’s forecast day or a date after dataThrough', async () => {
    const t = await team();
    await publishedChampion(t);
    const { calibrationId, job } = await finished(t, true);
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibrationId) });
    const replies = [
      await ask(t, 'admin', 'get_calibration', { calibrationId }),
      await ask(t, 'admin', 'compare_forecast_models', { calibrationId }),
    ];
    for (const { raw, views } of replies) {
      for (const secret of [CODE_VERSION, String(doc?.inputSha256), resultTokenOf(job.calibrationId) ?? 'no token', 'paramsJson', 'codeVersion', 'inputSha256', 'xgb', 'holidayLambdas', 'tokenSha256']) {
        expect(raw).not.toContain(secret);
        expect(JSON.stringify(views)).not.toContain(secret);
      }
      // dataThrough is 2026-05-31: the draft forecast starts the day after, and nothing in a result is later than the data.
      for (const date of raw.match(/\d{4}-\d{2}-\d{2}/g) ?? []) expect(date <= '2026-05-31').toBe(true);
      expect(raw).not.toContain('2026-06-01');
    }
    const started = await ask(t, 'admin', 'start_calibration');
    expect(started.raw).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('without a lab runner', () => {
  let off: Chat;
  beforeAll(async () => {
    const offModel = scriptedModel();
    off = { server: await startTownwiseServer({ chat: offModel }), model: offModel };
  });
  afterAll(async () => { await off.server.close(); });

  it('start_calibration answers lab_unavailable in words and starts nothing', async () => {
    const orgId = await createOrg(off.server, { name: `Lab Off ${randomUUID().slice(0, 6)}` });
    const locationId = await addLocation(off.server, { orgId, name: 'Hanover Room' });
    const admin = await seat(orgId, 'org_admin', off.server);
    const reply = await ask({ orgId, locationId, admin, member: admin }, 'admin', 'start_calibration', {}, { on: off });
    expect(reply.result).toEqual({ started: false, code: 'lab_unavailable', message: START_REFUSAL_WORDS.lab_unavailable });
    expect(reply.views).toEqual([{ input: { hasRegimeStart: false }, result: { started: false, status: null, code: 'lab_unavailable' } }]);
    expect(await off.server.connection.collection('tw_calibrations').countDocuments({})).toBe(0);
  });
});
