// The TownwiseAI tool registry (docs/portal/tuning-chat.md section 4). One file per tool in this folder; this file
// holds their order and runs a call. The order is frozen and append-only: stored conversations name their tool_use
// blocks, and the prompt cache keys on the tool list, so a tool is never renamed, removed or moved. A new tool goes
// at the end, in the PR that lands its data, and is then sent on every request; one whose data is missing answers
// `{ available: false, reason }` instead of being left out. api/test/chat-tools.test.ts pins the names.
import type { BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { TownwiseContext } from '../../app.ts';
import type { OrgScope } from '../../access/policy.ts';
import type { LocationRecord } from '../../stores/locations.ts';
import type { NoteContent } from '../../stores/notes.ts';
import type { Role } from '../../access/resolve.ts';
import type { AuditEventInput } from '../../stores/audit-events.ts';
import { compareForecastModelsTool, getCalibrationTool, startCalibrationTool } from './calibration.ts';
import { dayTool } from './day.ts';
import { forecastTool } from './forecast.ts';
import { listDataTool } from './list-data.ts';
import { suggestNextTool } from './next.ts';
import { notesTool } from './notes.ts';
import { overviewTool } from './overview.ts';
import { peopleInTownTool } from './people-in-town.ts';
import { proposeDataTool } from './propose-data.ts';
import { proposeNoteTool } from './propose-note.ts';
import { readDataTool } from './read-data.ts';
import { salesDaysTool } from './sales-days.ts';
import { townCalendarTool } from './town-calendar.ts';
import { townProfileTool } from './town-profile.ts';
import { showVisualTool, type Visual } from './visual.ts';

export interface ToolContext {
  readonly ctx: TownwiseContext;
  readonly scope: OrgScope;
  readonly location: LocationRecord;
  /** U13A: today in the location's town (time-zones.ts), YYYY-MM-DD. */
  readonly today: string;
  /** U13A: the town's IANA time zone. */
  readonly timeZone: string;
  /** The caller's role in the organization: the lab tools are for org admins. */
  readonly role: Role;
  /** The caller as chat.turn_completed records them, for the events a tool records. */
  readonly actor: Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'>;
  /**
   * What this turn has read so far, shared by its tool calls (D36). `readUntrusted` is set from the start when the
   * turn's requests carry the content of files attached to the person's message, and by read_data_item once it hands
   * back an item's text in this turn. While it is set, start_calibration (the one tool that acts at once) refuses, so
   * words from a file of Your data can never start it. A read from an earlier turn is sent again only as a stub
   * (savedTurn), so it never sets it.
   */
  readonly turn: { readUntrusted: boolean };
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What the owner sees of a tool call's input or result, on its card: ids, dates, counts and source links only, never
 * a figure (guests, dollars) or text. Views reach only the author's browser (and staff in view-as, who can already
 * read the conversation) and are never logged.
 */
export type ToolView = Readonly<Record<string, JsonValue>>;

/**
 * What a tool's run produced: the result the model reads, and what to show the owner: a note (propose_note), a visual
 * (show_visual) or the next questions (suggest_next).
 */
export interface ToolRun {
  readonly content: string;
  readonly proposal?: NoteContent;
  readonly visual?: Visual;
  readonly prompts?: string[];
}

/**
 * One tool. `parse` validates the raw input before anything runs; null makes the call an is_error result with
 * `invalidInput`, which the model can correct. Store failures in `run` throw: the turn then fails as a whole.
 */
export interface ChatTool<I> {
  /** eager_input_streaming: inputs stream unbuffered and are validated here instead. */
  readonly definition: BetaTool;
  readonly invalidInput: string;
  /** `today` is the town's local date, YYYY-MM-DD (U13A); only date rules read it. */
  parse(raw: unknown, today: string): I | null;
  run(tc: ToolContext, input: I): Promise<ToolRun>;
  inputView(input: I): ToolView | null;
  /** Recomputed from the result the model read, so a stored conversation shows the same card. Null when unreadable. */
  resultView(content: string): ToolView | null;
  /**
   * What the saved conversation keeps of a result that did not fail, when not the result itself: read_data_item keeps a
   * stub, so later turns never resend an item's text (turn.ts, savedTurn). `resultView` reads the stub too.
   */
  saved?(content: string): string;
}

export interface ToolOutcome {
  readonly result: BetaToolResultBlockParam;
  /** Set only when propose_note got a valid note. */
  readonly proposal: NoteContent | null;
  /** Set only when show_visual drew one. */
  readonly visual: Visual | null;
  /** Set only when suggest_next got three valid prompts. */
  readonly prompts: string[] | null;
}

const NOTHING_SHOWN = { proposal: null, visual: null, prompts: null } as const;

/** In this order on every request. Append only. */
export const TOOL_REGISTRY: readonly ChatTool<unknown>[] = [
  overviewTool,
  salesDaysTool,
  notesTool,
  townProfileTool,
  proposeNoteTool,
  // U13A: the town calendar and people in town.
  townCalendarTool,
  peopleInTownTool,
  // U13B: the published forecast.
  forecastTool,
  // F2: everything Townwise has for one day.
  dayTool,
  // Chat redesign A4: visuals drawn from Townwise's data, and the next questions (a reply's last step).
  showVisualTool,
  suggestNextTool,
  // Your data: what the team added, and the text of a reference item.
  listDataTool,
  readDataTool,
  // Your data: a card proposing to keep text the owner gave.
  proposeDataTool,
  // The forecast lab: org admins calibrate a location's forecast and read how it went.
  startCalibrationTool,
  getCalibrationTool,
  compareForecastModelsTool,
];

/** The tool definitions sent to the model, in registry order. */
export const TOOLS: readonly BetaTool[] = TOOL_REGISTRY.map((tool) => tool.definition);

const BY_NAME: ReadonlyMap<string, ChatTool<unknown>> = new Map(TOOL_REGISTRY.map((tool) => [tool.definition.name, tool]));

/** The registered tool with this name, else undefined. */
export function toolNamed(name: string): ChatTool<unknown> | undefined {
  return BY_NAME.get(name);
}

/** Runs one tool call. Store failures throw: the turn then fails as a whole. */
export async function runTool(tc: ToolContext, block: BetaToolUseBlock): Promise<ToolOutcome> {
  const tool = toolNamed(block.name);
  if (tool === undefined) return { result: failed(block, 'Unknown tool.'), ...NOTHING_SHOWN };
  const input = tool.parse(block.input, tc.today);
  if (input === null) return { result: failed(block, tool.invalidInput), ...NOTHING_SHOWN };
  const run = await tool.run(tc, input);
  return {
    result: { type: 'tool_result', tool_use_id: block.id, content: run.content },
    proposal: run.proposal ?? null, visual: run.visual ?? null, prompts: run.prompts ?? null,
  };
}

function failed(block: BetaToolUseBlock, content: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: block.id, is_error: true, content };
}

/** The input view of a call to a registered tool; null for an unknown tool, an invalid input or a tool with none. */
export function inputViewOf(name: string, raw: unknown, today: string): ToolView | null {
  const tool = toolNamed(name);
  const input = tool?.parse(raw, today) ?? null;
  return tool === undefined || input === null ? null : tool.inputView(input);
}

/** What the saved conversation keeps of one result: the tool's stub of a result that did not fail, else the same block. */
export function savedResultOf(name: string, result: BetaToolResultBlockParam): BetaToolResultBlockParam {
  const tool = toolNamed(name);
  if (tool?.saved === undefined || result.is_error === true || typeof result.content !== 'string') return result;
  const content = tool.saved(result.content);
  return content === result.content ? result : { ...result, content };
}

/** The result view of a call that did not fail; null for an unknown tool, an error result or an unreadable one. */
export function resultViewOf(name: string, result: BetaToolResultBlockParam): ToolView | null {
  const tool = toolNamed(name);
  if (tool === undefined || result.is_error === true || typeof result.content !== 'string') return null;
  return tool.resultView(result.content);
}
