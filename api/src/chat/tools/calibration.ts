// The forecast lab's three TownwiseAI tools (forecast lab design call 7), for org admins: start a calibration, read its
// status and scorecard, and compare it with the published forecast. Results carry the words, the gate's reason, chart
// and card components for the app to draw (lab/components.ts) and three suggested next steps; until the chat redesign
// renders them, only the model reads them. A result never carries the model's parameters, its code version, its input
// hash, a token, a draft forecast day or a date after the data the calibration saw (checkLabResult refuses a scorecard
// week after it); its card (the result view) carries counts only.
//
// [CONFIRM: lab tools show backtest forecasts to org admins and Anthropic while forecasts are off] The components carry
// a calibration's backtest and comparison weeks (the owner's own history, design call 10) whether or not staff have
// switched the organization's forecasts on (G1).
import { objectId } from '@ckeith26/mongo';
import { z } from 'zod';

import { recordAfter } from '../../audit.ts';
import { nextRefreshFor } from '../../calibration.ts';
import { isoDate } from '../../dates.ts';
import {
  backtestChart, comparisonChart, comparisonTable, metricCards, NEXT_STEPS, type ChatComponent, type NextStepsKind,
} from '../../lab/components.ts';
import { GATE_REASONS, gateWords, type GateReason } from '../../lab/gate.ts';
import { scorecardSchema, type Scorecard } from '../../lab/scorecard.ts';
import { checkStart, expireStale, FAILURE_WORDS, launch, START_REFUSAL_WORDS, type StartRequest } from '../../lab/service.ts';
import { shortDate } from '../../orders/dates.ts';
import type { CalibrationRecord } from '../../stores/calibrations.ts';
import type { AuditEventInput } from '../../stores/audit-events.ts';
import { Types } from 'mongoose';
import type { ChatTool, ToolContext, ToolView } from './registry.ts';
import { INVALID_INPUT, viewOf } from './shared.ts';

const NOT_ADMIN = 'Only an org admin can calibrate forecasts or see calibrations.';
const NOT_FOUND = 'There is no such calibration for this location.';
const NONE_YET = 'This location has no calibration yet.';
const NOT_FINISHED = 'The calibration hasn’t finished yet.';
/**
 * D36: a turn that read a file's content (attached to the message, or read with read_data_item) never starts a
 * calibration, so a file's words can't start one.
 */
const FILE_TURN = 'A calibration can’t start in a turn that read a file from Your data. Ask the owner to confirm in a new message.';
/**
 * D37: nor in one whose requests carry web pages a search found. The API puts a search's results back in the model's
 * context on every later request of the conversation, so the owner asks for it in a new conversation.
 */
const WEB_TURN = 'A calibration can’t start in a conversation that read web pages. Ask the owner to ask for it in a new conversation.';

const startInput = z.strictObject({ regimeStart: isoDate.optional() });
const namedInput = z.strictObject({ calibrationId: objectId.optional() });

export interface StartInput { regimeStart: string | null }
export interface NamedInput { calibrationId: string | null }

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}

function isGateReason(reason: string): reason is GateReason {
  return (GATE_REASONS as readonly string[]).includes(reason);
}

function scorecardOf(record: CalibrationRecord): Scorecard | null {
  if (record.scorecardJson === null) return null;
  try {
    const parsed = scorecardSchema.safeParse(JSON.parse(record.scorecardJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The calibration named, else the location's newest, a live one past its 20 minutes failed as timeout first. */
async function calibrationOf(tc: ToolContext, calibrationId: string | null): Promise<CalibrationRecord | 'none' | 'not_found'> {
  const { ctx, scope, location } = tc;
  const found = calibrationId === null
    ? (await ctx.stores.calibrations.list(scope, 1, location.id))[0] ?? null
    : await ctx.stores.calibrations.find(scope, calibrationId);
  if (found === null) return calibrationId === null ? 'none' : 'not_found';
  if (found.locationId !== location.id) return 'not_found';
  return expireStale(ctx, scope, found);
}

function stepsFor(kind: NextStepsKind): string[] {
  return [...NEXT_STEPS[kind]];
}

function unavailable(reason: string): { content: string } {
  return json({ available: false, reason });
}

const startResult = z.object({ started: z.boolean(), status: z.string().nullable().optional(), code: z.string().nullable().optional() });
const readResult = z.object({
  available: z.boolean(), status: z.string().nullable().optional(), weeks: z.number().nullable().optional(),
  published: z.boolean().nullable().optional(),
});

export const startCalibrationTool: ChatTool<StartInput> = {
  definition: {
    name: 'start_calibration',
    description: 'Start a calibration: Townwise refits this location’s forecast model on its sales history and notes, on Townwise’s own servers, and scores it on held-out weeks. Only when an org admin asks to retrain or calibrate. It uses part of the organization’s monthly TownwiseAI budget. regimeStart (optional): the first day of a lasting change in the weekly pattern the owner described.',
    input_schema: {
      type: 'object',
      properties: { regimeStart: { type: 'string', description: 'YYYY-MM-DD' } },
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse(raw) {
    const input = startInput.safeParse(raw);
    return input.success ? { regimeStart: input.data.regimeStart ?? null } : null;
  },
  inputView: (input) => ({ hasRegimeStart: input.regimeStart !== null }),
  resultView: (content) => viewOf(content, startResult, ({ started, status, code }) => ({
    started, status: status ?? null, code: code ?? null,
  })),
  async run(tc, input) {
    if (tc.role !== 'org_admin') return json({ started: false, code: 'org_admin_only', message: NOT_ADMIN });
    if (tc.turn.readWeb) return json({ started: false, code: 'web_turn', message: WEB_TURN });
    if (tc.turn.readUntrusted) return json({ started: false, code: 'file_turn', message: FILE_TURN });
    const { ctx, scope, location } = tc;
    const request: StartRequest = {
      id: new Types.ObjectId().toHexString(), scope, location,
      // Staff who have the organization open as admin (D25) act with the org admin role but stay staff.
      requester: { userId: tc.actor.actorUserId, role: tc.actor.actorRole === 'superadmin' ? 'superadmin' : 'org_admin', via: 'chat' },
      regimeStart: input.regimeStart, today: tc.today,
    };
    const refusal = await checkStart(ctx, request);
    if (refusal !== null) return json({ started: false, code: refusal, message: START_REFUSAL_WORDS[refusal] });
    // Recorded after the effect, at the time of the request, so it comes before the calibration's own finish.
    const event: AuditEventInput = {
      ...tc.actor, at: ctx.now(), orgId: scope.orgId, action: 'calibration.requested',
      target: { type: 'calibration', id: request.id },
      details: { locationId: location.id, calibrationId: request.id, via: 'chat', hasRegime: request.regimeStart !== null },
    };
    const launched = await launch(ctx, request);
    // A job that couldn't start leaves a calibration failed start_failed, so its request is recorded too; the other
    // refusals left none.
    if (launched.ok || launched.code === 'start_failed') await recordAfter(ctx, event);
    if (!launched.ok) return json({ started: false, code: launched.code, message: START_REFUSAL_WORDS[launched.code] });
    // While the weekly refresh considers the location (D42), say that it refits by itself at no charge.
    const nextRefresh = await nextRefreshFor(ctx, scope, location);
    const weekly = nextRefresh === null ? '' : ` Townwise also refits this location by itself each Monday at no charge, next on ${shortDate(nextRefresh)}.`;
    return json({
      started: true, status: launched.calibration.status, calibrationId: launched.calibration.id,
      message: `The calibration is running on Townwise’s servers and usually takes a few minutes. It used part of this month’s TownwiseAI budget.${weekly}`,
      suggestedNextSteps: stepsFor('started'),
    });
  },
};

const namedParse = (raw: unknown): NamedInput | null => {
  const input = namedInput.safeParse(raw);
  return input.success ? { calibrationId: input.data.calibrationId ?? null } : null;
};
const namedInputView = (input: NamedInput): ToolView | null => (input.calibrationId === null ? null : { calibrationId: input.calibrationId });
const namedResultView = (content: string): ToolView | null => viewOf(content, readResult, ({ available, status, weeks, published }) => ({
  available, status: status ?? null, weeks: weeks ?? null, published: published ?? null,
}));

export const getCalibrationTool: ChatTool<NamedInput> = {
  definition: {
    name: 'get_calibration',
    description: 'The status and scorecard of this location’s newest calibration, or the one named.',
    input_schema: {
      type: 'object',
      properties: { calibrationId: { type: 'string', description: 'A calibration id from start_calibration' } },
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: namedParse,
  inputView: namedInputView,
  resultView: namedResultView,
  async run(tc, input) {
    if (tc.role !== 'org_admin') return unavailable(NOT_ADMIN);
    const record = await calibrationOf(tc, input.calibrationId);
    if (record === 'none') return unavailable(NONE_YET);
    if (record === 'not_found') return unavailable(NOT_FOUND);
    const base = { available: true, calibrationId: record.id, status: record.status };
    if (record.status === 'failed') {
      return json({
        ...base, weeks: null, published: null, failure: record.failure === null ? null : FAILURE_WORDS[record.failure],
        regimeStart: record.regimeStart, suggestedNextSteps: stepsFor('failed'),
      });
    }
    const scorecard = scorecardOf(record);
    if (record.status !== 'succeeded' || scorecard === null) {
      return json({ ...base, weeks: null, published: null, message: NOT_FINISHED, suggestedNextSteps: stepsFor('started') });
    }
    const published = record.gate?.published === true;
    const comparison = scorecard.comparison;
    const components: ChatComponent[] = [
      backtestChart(scorecard),
      comparison === null
        ? metricCards(scorecard.backtest.metrics, null, scorecard.backtest.weeks)
        : metricCards(comparison.challenger, comparison.champion, comparison.weeks),
    ];
    return json({
      ...base, weeks: comparison?.weeks ?? scorecard.backtest.weeksWithRange, published, regimeStart: record.regimeStart,
      gate: record.gate === null ? null : (isGateReason(record.gate.reason) ? gateWords(record.gate.reason, comparison === null) : null),
      components, suggestedNextSteps: stepsFor(published ? 'published' : 'draft'),
    });
  },
};

export const compareForecastModelsTool: ChatTool<NamedInput> = {
  definition: {
    name: 'compare_forecast_models',
    description: 'How a calibration compared with the published forecast on the same held-out weeks, and whether it was published and why.',
    input_schema: {
      type: 'object',
      properties: { calibrationId: { type: 'string', description: 'A calibration id from start_calibration' } },
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: namedParse,
  inputView: namedInputView,
  resultView: namedResultView,
  async run(tc, input) {
    if (tc.role !== 'org_admin') return unavailable(NOT_ADMIN);
    const record = await calibrationOf(tc, input.calibrationId);
    if (record === 'none') return unavailable(NONE_YET);
    if (record === 'not_found') return unavailable(NOT_FOUND);
    if (record.status === 'failed') return unavailable(record.failure === null ? 'The calibration failed.' : FAILURE_WORDS[record.failure]);
    const scorecard = scorecardOf(record);
    if (record.status !== 'succeeded' || scorecard === null) return unavailable(NOT_FINISHED);
    const { comparison } = scorecard;
    if (comparison === null) return unavailable('There was no published forecast to compare this calibration with.');
    const published = record.gate?.published === true;
    return json({
      available: true, calibrationId: record.id, status: record.status, weeks: comparison.weeks, published,
      gate: record.gate === null ? null : (isGateReason(record.gate.reason) ? gateWords(record.gate.reason, false) : null),
      components: [comparisonTable(comparison), comparisonChart(comparison)], suggestedNextSteps: stepsFor('compared'),
    });
  },
};
