import { liveLine } from '../../src/chat/liveLine';
import type { ToolContext, ToolStep } from '../../src/chat/tools';
import type { ChatMessage, MessagePart } from '../../src/chat/useTuningChat';
import { SALES_STEP } from '../helpers/chat';
import { daily } from './visuals-fixtures';

// The live line under a streaming reply (owner decision 4): the running step's sentence, "TownwiseAI is thinking…"
// before anything arrives and between steps, and nothing while text streams or once the reply ends.

const CTX: ToolContext = { town: 'Hanover', hasTownProfile: true };

let keys = 0;
function key(): string {
  keys += 1;
  return `k${String(keys)}`;
}

function reply(parts: MessagePart[], state: ChatMessage['state']): ChatMessage {
  return {
    key: key(), role: 'assistant', parts, state, note: null, nodeId: null, parentId: null, feedback: null, ratingError: null, next: null, request: null,
  };
}

const streaming = (parts: MessagePart[]): ChatMessage => reply(parts, 'streaming');
const tools = (steps: ToolStep[]): MessagePart => ({ type: 'tools', key: key(), steps });
const text = (value: string): MessagePart => ({ type: 'text', key: key(), text: value });
interface Call { id: string; name: string; input: Record<string, unknown>; result: Record<string, unknown> }
const running = (step: Call): ToolStep => ({ id: step.id, name: step.name, state: 'running', input: { ...step.input }, result: null });
const done = (step: Call): ToolStep => ({ ...running(step), state: 'done', result: { ...step.result } });

it('names the running step, thinks between steps and before anything arrives, and says nothing while text streams', () => {
  expect(liveLine(streaming([]), CTX)).toBe('TownwiseAI is thinking…');
  expect(liveLine(streaming([tools([running(SALES_STEP)])]), CTX)).toBe('Reading your sales for Dec 1 to Dec 31, 2025…');
  expect(liveLine(streaming([text('So far')]), CTX)).toBeNull();
});

it('thinks once every step has read, after a visual, and after text that a step followed', () => {
  expect(liveLine(streaming([tools([done(SALES_STEP)])]), CTX)).toBe('TownwiseAI is thinking…');
  expect(liveLine(streaming([text('Here it is.'), { type: 'visual', key: key(), id: 'v1', visual: daily }]), CTX)).toBe('TownwiseAI is thinking…');
  expect(liveLine(streaming([text('Let me look.'), tools([done(SALES_STEP), running({ ...SALES_STEP, id: 'toolu_test_0003' })])]), CTX))
    .toBe('Reading your sales for Dec 1 to Dec 31, 2025…');
});

it('a tool the table doesn’t know reads in general words', () => {
  const unknown: ToolStep = { id: 't9', name: 'get_weather', state: 'running', input: null, result: null };
  expect(liveLine(streaming([tools([unknown])]), CTX)).toBe('Looking something up…');
});

it('says nothing once the reply ends, however it ended', () => {
  for (const state of ['complete', 'stopped', 'failed'] as const) {
    expect(liveLine(reply([], state), CTX)).toBeNull();
    expect(liveLine(reply([tools([running(SALES_STEP)])], state), CTX)).toBeNull();
  }
});

it('says nothing for the person’s own message', () => {
  expect(liveLine({ ...streaming([]), role: 'user' }, CTX)).toBeNull();
});
