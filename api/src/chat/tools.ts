// The five tuning chat tools (docs/portal/tuning-chat.md section 4): four read the location's own data through the
// tenant stores, and propose_note only validates. Every input is checked with zod before anything runs; a failure
// is an is_error result the model can correct. Results are JSON the model reads as data.
import type { BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { OrgScope } from '../access/policy.ts';
import { calibrationOf } from '../calibration.ts';
import { daysBetween, isoDate } from '../dates.ts';
import { readNoteContent } from '../handlers/notes.ts';
import { townProfileOf } from '../handlers/towns.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent } from '../stores/notes.ts';

export interface ToolContext {
  readonly ctx: TownwiseContext;
  readonly scope: OrgScope;
  readonly location: LocationRecord;
  /** The UTC date, YYYY-MM-DD. */
  readonly today: string;
}

export interface ToolOutcome {
  readonly result: BetaToolResultBlockParam;
  /** Set only when propose_note got a valid note. */
  readonly proposal: NoteContent | null;
}

/** Spec text: "Shown to the owner as a proposal. They decide whether to add it." */
export const PROPOSAL_RESULT = 'Shown to the owner as a proposal. They decide whether to add it.';

const MAX_SALES_RANGE_DAYS = 92;
const OVERVIEW_MONTHS = 24;

const noInput = z.object({});
const salesRange = z.object({ from: isoDate, to: isoDate })
  .refine((range) => range.from <= range.to && daysBetween(range.from, range.to) < MAX_SALES_RANGE_DAYS);

function dollars(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

function ok(block: BetaToolUseBlock, content: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: block.id, content };
}

function failed(block: BetaToolUseBlock, content: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: block.id, is_error: true, content };
}

const INVALID_INPUT = 'Invalid input for this tool. Check the input schema and try again.';
const INVALID_RANGE = 'Invalid input: from and to are YYYY-MM-DD dates, from on or before to, at most 92 days apart counting both ends.';
const INVALID_NOTE = 'Not a valid note, so nothing was shown to the owner. Check the rules in the tool description and try again.';

async function overview(tc: ToolContext): Promise<string> {
  const { ctx, scope, location } = tc;
  const [coverage, months] = await Promise.all([
    ctx.stores.salesDays.coverage(scope, location.id),
    ctx.stores.salesDays.months(scope, location.id),
  ]);
  return JSON.stringify({
    location: { name: location.name, town: { name: location.town.name, state: location.town.state } },
    today: tc.today,
    coverage: {
      firstDate: coverage.firstDate, lastDate: coverage.lastDate, dayCount: coverage.dayCount,
      guestsDayCount: coverage.guestsDayCount, netSalesDayCount: coverage.netSalesDayCount, missingDays: coverage.missingDays,
    },
    calibration: calibrationOf(coverage).state,
    townProfile: location.town.townId !== null && townProfileOf(location.town.townId) !== undefined,
    months: months.slice(-OVERVIEW_MONTHS).map((month) => ({
      month: month.month, days: month.dayCount, guests: month.guests, netSalesUsd: dollars(month.netSalesCents),
    })),
  });
}

async function salesDays(tc: ToolContext, range: { from: string; to: string }): Promise<string> {
  const days = await tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, range);
  return JSON.stringify({
    from: range.from, to: range.to,
    days: days.map((day) => ({ date: day.date, guests: day.guests, netSalesUsd: dollars(day.netSalesCents) })),
  });
}

async function notes(tc: ToolContext): Promise<string> {
  const list = await tc.ctx.stores.notes.list(tc.scope, tc.location.id);
  return JSON.stringify({
    notes: list.map((note) => ({
      kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
      expectedGuests: note.expectedGuests, detail: note.detail,
    })),
  });
}

function townProfile(tc: ToolContext): string {
  const { townId } = tc.location.town;
  const profile = townId === null ? undefined : townProfileOf(townId);
  return JSON.stringify({ profile: profile ?? null });
}

/** Runs one tool call. Store failures throw: the turn then fails as a whole. */
export async function runTool(tc: ToolContext, block: BetaToolUseBlock): Promise<ToolOutcome> {
  const answer = (result: BetaToolResultBlockParam, proposal: NoteContent | null = null): ToolOutcome => ({ result, proposal });
  switch (block.name) {
    case 'get_location_overview':
      if (!noInput.safeParse(block.input).success) return answer(failed(block, INVALID_INPUT));
      return answer(ok(block, await overview(tc)));
    case 'get_sales_days': {
      const range = salesRange.safeParse(block.input);
      if (!range.success) return answer(failed(block, INVALID_RANGE));
      return answer(ok(block, await salesDays(tc, range.data)));
    }
    case 'list_notes':
      if (!noInput.safeParse(block.input).success) return answer(failed(block, INVALID_INPUT));
      return answer(ok(block, await notes(tc)));
    case 'get_town_profile':
      if (!noInput.safeParse(block.input).success) return answer(failed(block, INVALID_INPUT));
      return answer(ok(block, townProfile(tc)));
    case 'propose_note': {
      const note = readNoteContent(block.input, tc.today);
      if (note === null) return answer(failed(block, INVALID_NOTE));
      return answer(ok(block, PROPOSAL_RESULT), note);
    }
    default:
      return answer(failed(block, 'Unknown tool.'));
  }
}
