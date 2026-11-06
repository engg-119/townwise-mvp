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
import { notesTool } from './notes.ts';
import { overviewTool } from './overview.ts';
import { peopleInTownTool } from './people-in-town.ts';
import { proposeNoteTool } from './propose-note.ts';
import { salesDaysTool } from './sales-days.ts';
import { townCalendarTool } from './town-calendar.ts';
import { townProfileTool } from './town-profile.ts';

export interface ToolContext {
  readonly ctx: TownwiseContext;
  readonly scope: OrgScope;
  readonly location: LocationRecord;
  /** U13A: today in the location's town (time-zones.ts), YYYY-MM-DD. */
  readonly today: string;
  /** U13A: the town's IANA time zone. */
  readonly timeZone: string;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What the owner sees of a tool call's input or result, on its card: ids, dates, counts and source links only, never
 * a figure (guests, dollars) or text. Views reach only the author's browser (and staff in view-as, who can already
 * read the conversation) and are never logged.
 */
export type ToolView = Readonly<Record<string, JsonValue>>;

/** What a tool's run produced: the result the model reads, and a note to show the owner (propose_note only). */
export interface ToolRun {
  readonly content: string;
  readonly proposal?: NoteContent;
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
}

export interface ToolOutcome {
  readonly result: BetaToolResultBlockParam;
  /** Set only when propose_note got a valid note. */
  readonly proposal: NoteContent | null;
}

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
  if (tool === undefined) return { result: failed(block, 'Unknown tool.'), proposal: null };
  const input = tool.parse(block.input, tc.today);
  if (input === null) return { result: failed(block, tool.invalidInput), proposal: null };
  const run = await tool.run(tc, input);
  return { result: { type: 'tool_result', tool_use_id: block.id, content: run.content }, proposal: run.proposal ?? null };
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

/** The result view of a call that did not fail; null for an unknown tool, an error result or an unreadable one. */
export function resultViewOf(name: string, result: BetaToolResultBlockParam): ToolView | null {
  const tool = toolNamed(name);
  if (tool === undefined || result.is_error === true || typeof result.content !== 'string') return null;
  return tool.resultView(result.content);
}
