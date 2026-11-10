// The forecast lab's three TownwiseAI tools through a real chat turn (scripted model, helpers/chat-model.ts) and the lab's
// own job callback (helpers/lab.ts): the org-admin rule, starting a calibration (its event after the effect, its
// refusals in words), reading its scorecard as components, comparing it with the published forecast, and results
// and cards with no parameters, code version, input hash, token, draft forecast day or date after the data. Every number
// is synthetic.
import { randomUUID } from 'node:crypto';

import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NEXT_STEPS } from '../src/lab/components.ts';
import { GATE_WORDS } from '../src/lab/gate.ts';
import { labInputSchema, type LabInput } from '../src/lab/input.ts';
import { LabStartError } from '../src/lab/runner.ts';
import { START_REFUSAL_WORDS } from '../src/lab/service.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, messagesOf, scriptedModel, text, toolUse, type ScriptedModel } from './helpers/chat-model.ts';
import { CODE_VERSION, fakeLabRunner, jobCall, labFailure, labResultFor, runDays, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { comparisonWith, scorecardWith } from './lab-fixtures.ts';
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
interface Job { calibrationId: string; token: string }
interface Reply { result: Record<string, unknown>; raw: string; views: { input: unknown; result: unknown }[]; isError: boolean }

async function seat(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

/** An organization with an org admin, a member and a Hanover location holding guests from `from` to 2026-05-31. */
async function team(from = '2025-01-01'): Promise<Team> {
  const orgId = await createOrg(server, { name: `Lab Chat ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
  await seedHistory(server, { orgId, locationId, from, to: '2026-05-31' });
  return { orgId, locationId, admin: await seat(orgId, 'org_admin'), member: await seat(orgId, 'member') };
}

function toolResultsOf(param: BetaMessageParam | undefined): BetaToolResultBlockParam[] {
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return [];
  return param.content.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
}

/** One chat turn in which the model calls `name` once; the tool's result and the views its card streamed. */
async function ask(t: Team, who: 'admin' | 'member', name: string, input: unknown = {}): Promise<Reply> {
  const id = `toolu_${randomUUID().slice(0, 8)}`;
  model.script(
    { kind: 'message', message: message([toolUse(id, name, input)]) },
    { kind: 'message', message: message([text('Done.')]) },
  );
  const calls = model.calls.length;
  const res = await call(server, `/api/org/locations/${t.locationId}/chat/turns`, { session: t[who], json: { content: 'Calibrate' } });
  expect(res.status).toBe(200);
  const body = await res.text();
  const views = body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n');
    if (lines.find((line) => line.startsWith('event: '))?.slice(7) !== 'tool') return [];
    const data = JSON.parse(lines.find((line) => line.startsWith('data: '))?.slice(6) ?? 'null') as { state: string; input: unknown; result: unknown };
    return data.state === 'running' ? [] : [{ input: data.input, result: data.result }];
  });
  const [block] = toolResultsOf(messagesOf(model.calls[calls + 1]).at(-1));
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
        ...comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.15 }), championRunId: input.champion?.runId ?? '',
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
    expect((await jobCall(server, finishedJob, 'result', labFailure(finishedJob, 'internal'))).status).toBe(200);
    await refusal('invalid_regime_start', t, { regimeStart: '2026-05-20' });
    await refusal('not_enough_history', await team('2025-04-07'));
    // budget_exhausted has no chat path to test: a turn stops after a model call that spends the month, before any tool runs
    // (lab.int.test.ts covers the start's own budget check).
    runner.failNext(new LabStartError('upstream_status', { status: 403 }));
    await refusal('start_failed', await team());
    for (let n = 1; n <= 3; n += 1) {
      const more = await ask(t, 'admin', 'start_calibration');
      expect(more.result.started).toBe(true);
      const job = runner.jobs.at(-1);
      if (job === undefined) throw new Error('no job');
      expect((await jobCall(server, job, 'result', labFailure(job, 'internal'))).status).toBe(200);
    }
    await refusal('rate_limited', t);
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
    expect(reply.views).toEqual([{ input: null, result: { available: true, status: 'succeeded', weeks: 12, published: false } }]);
    // A named calibration of another location is not found.
    const other = await team();
    expect(await ask(other, 'admin', 'get_calibration', { calibrationId })).toMatchObject({
      result: { available: false, reason: 'There is no such calibration for this location.' },
    });
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
      available: true, calibrationId, status: 'succeeded', weeks: 12, published: false, gate: GATE_WORDS.forecasts_off,
      suggestedNextSteps: [...NEXT_STEPS.compared],
    });
    const [table, chart] = reply.result.components as { type: string; columns?: unknown; rows: { label?: string; current?: string; candidate?: string; compare?: number | null }[] }[];
    expect(table).toMatchObject({ type: 'comparison_table', columns: ['', 'Current forecast', 'New calibration'] });
    expect(table?.rows[0]).toEqual({ label: 'Weekly error (WAPE)', current: '20.0%', candidate: '15.0%' });
    expect(chart).toMatchObject({ type: 'line_band_chart', series: [{ label: 'Actual' }, { label: 'Forecast' }, { label: 'Current forecast' }] });
    expect(chart?.rows[0]).toEqual({ x: '2026-03-02', actual: 300, mid: 296, low: 250, high: 341, compare: 310 });
    expect(reply.views).toEqual([{ input: { calibrationId }, result: { available: true, status: 'succeeded', weeks: 12, published: false } }]);

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
      for (const secret of [CODE_VERSION, String(doc?.inputSha256), job.token, 'paramsJson', 'codeVersion', 'inputSha256', 'xgb', 'holidayLambdas', 'tokenSha256']) {
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
