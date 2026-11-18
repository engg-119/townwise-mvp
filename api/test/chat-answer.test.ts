// TownwiseAI's answer and its working notes (docs/portal/tuning-chat.md section 3, "Working notes"), against a scripted
// model, without Docker: text no lookup followed is the answer, so suggest_next then ends the turn; text a lookup
// followed is working notes, so suggest_next asks for the answer, in words that never say the owner saw nothing.
import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { SUGGESTIONS_RESULT, UNANSWERED_RESULT } from '../src/chat/tools/next.ts';
import type { ToolContext } from '../src/chat/tools/registry.ts';
import { DISPLAY_TOOLS, isWork, runTurn, type TurnEvent, type TurnResult } from '../src/chat/turn.ts';
import { message, messagesOf, scriptedModel, text, toolUse, type ScriptedModel, type Step } from './helpers/chat-model.ts';

const NEXT = { prompts: ['Which day was slowest?', 'Show me June', 'Any notes soon?'] };

/** One turn of `steps`. show_visual and the proposals get an input they refuse, which needs no store: a card shows nothing. */
async function run(steps: Step[]): Promise<{ model: ScriptedModel; result: TurnResult; events: TurnEvent[] }> {
  const model = scriptedModel();
  model.script(...steps);
  const tools = { role: 'org_admin', today: '2026-06-01', turn: { readUntrusted: false, readWeb: false } } as unknown as ToolContext;
  const events: TurnEvent[] = [];
  const result = await runTurn({
    model, tools, history: [], userMessage: { role: 'user', content: 'What were my five busiest days?' }, expanded: null,
    nodes: { user: { id: 'u1', parentId: null }, reply: { id: 'a1', parentId: 'u1' } }, signal: new AbortController().signal,
    now: () => new Date('2026-06-01T12:00:00.000Z'), emit: (event) => { events.push(event); },
    charge: () => Promise.resolve(), budgetSpent: () => Promise.resolve(false),
  });
  return { model, result, events };
}

function resultsOf(param: BetaMessageParam | undefined): BetaToolResultBlockParam[] {
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return [];
  return param.content.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
}

describe('an answer written beside a display tool', () => {
  it('counts as the answer: suggest_next alone then ends the turn after 2 calls, not 3 (the double answer)', async () => {
    const { model, result } = await run([
      { kind: 'message', message: message([text('Your busiest day was May 2.'), toolUse('v1', 'show_visual', {})]) },
      { kind: 'message', message: message([toolUse('n1', 'suggest_next', NEXT)]) },
      { kind: 'message', message: message([text('Again: your busiest day was May 2.')]) },
    ]);
    expect(model.calls).toHaveLength(2);
    expect(result).toMatchObject({ kind: 'done', stopReason: 'end_turn', calls: 2 });
    const saved = result.kind === 'done' ? result.messages.map((m) => JSON.parse(m.param) as BetaMessageParam) : [];
    expect(resultsOf(saved.at(-1))).toEqual([{ type: 'tool_result', tool_use_id: 'n1', content: SUGGESTIONS_RESULT }]);
  });

  it.each([...DISPLAY_TOOLS])('so does text before %s', async (name) => {
    const { model } = await run([
      { kind: 'message', message: message([text('Here is what I found.'), toolUse('d1', name, {})]) },
      { kind: 'message', message: message([toolUse('n1', 'suggest_next', NEXT)]) },
    ]);
    expect(model.calls).toHaveLength(2);
  });
});

describe('working notes before a lookup', () => {
  it('are no answer: suggest_next asks for one, without saying the owner saw nothing', async () => {
    const { model, result } = await run([
      { kind: 'message', message: message([text('Let me check your May sales.'), toolUse('r1', 'get_sales_days', {})]) },
      { kind: 'message', message: message([toolUse('n1', 'suggest_next', NEXT)]) },
      { kind: 'message', message: message([text('May 2 was your busiest day.')]) },
    ]);
    expect(model.calls).toHaveLength(3);
    expect(resultsOf(messagesOf(model.calls[2]).at(-1))).toEqual([{ type: 'tool_result', tool_use_id: 'n1', content: UNANSWERED_RESULT }]);
    expect(UNANSWERED_RESULT).not.toMatch(/has not seen|never saw|not seen an answer/);
    expect(UNANSWERED_RESULT).toMatch(/without mentioning an earlier answer or this note/);
    expect(result).toMatchObject({ kind: 'done', stopReason: 'end_turn', calls: 3 });
  });

  it('a lookup after an answer and a visual turns that answer into notes too, so the answer is asked for again', async () => {
    const { model } = await run([
      { kind: 'message', message: message([text('May 2 was busiest.'), toolUse('v1', 'show_visual', {})]) },
      { kind: 'message', message: message([toolUse('r1', 'get_sales_days', {})]) },
      { kind: 'message', message: message([toolUse('n1', 'suggest_next', NEXT)]) },
      { kind: 'message', message: message([text('May 2 was busiest, and no note explains it.')]) },
    ]);
    expect(model.calls).toHaveLength(4);
  });
});

describe('isWork', () => {
  const ran: BetaToolResultBlockParam = { type: 'tool_result', tool_use_id: 'x', content: '{}' };
  it('is a registered lookup that ran; never suggest_next, a display tool, an unknown tool or a call that never ran', () => {
    expect(isWork('get_sales_days', ran)).toBe(true);
    expect(isWork('start_calibration', ran)).toBe(true);
    expect(isWork('get_sales_days', { ...ran, is_error: true, content: 'Invalid input: from is a date.' })).toBe(true);
    expect(isWork('get_sales_days', { ...ran, is_error: true, content: 'Not run: the reply stopped before this call could run.' })).toBe(false);
    expect(isWork('get_sales_days', undefined)).toBe(false);
    expect(isWork('suggest_next', ran)).toBe(false);
    expect(isWork('show_visual', ran)).toBe(false);
    expect(isWork('no_such_tool', ran)).toBe(false);
  });
});
