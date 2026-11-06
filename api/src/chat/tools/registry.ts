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
import { proposeNoteTool } from './propose-note.ts';
import { salesDaysTool } from './sales-days.ts';
import { townProfileTool } from './town-profile.ts';

export interface ToolContext {
  readonly ctx: TownwiseContext;
  readonly scope: OrgScope;
  readonly location: LocationRecord;
  /** The UTC date, YYYY-MM-DD. */
  readonly today: string;
}

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
  parse(raw: unknown, tc: ToolContext): I | null;
  run(tc: ToolContext, input: I): Promise<ToolRun>;
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
  const input = tool.parse(block.input, tc);
  if (input === null) return { result: failed(block, tool.invalidInput), proposal: null };
  const run = await tool.run(tc, input);
  return { result: { type: 'tool_result', tool_use_id: block.id, content: run.content }, proposal: run.proposal ?? null };
}

function failed(block: BetaToolUseBlock, content: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: block.id, is_error: true, content };
}
