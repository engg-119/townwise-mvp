import { liveLine } from '../../src/chat/liveLine';
import type { ToolStep } from '../../src/chat/tools';
import type { ChatMessage, MessagePart } from '../../src/chat/useTuningChat';
import { SALES_STEP } from '../helpers/chat';
import { daily } from './visuals-fixtures';

// The live line in a streaming reply's timeline: "Thinking…" before anything arrives and between steps, and nothing
// while a step runs (its row says so), while thinking or text streams, or once the reply ends.

let keys = 0;
function key(): string {
  keys += 1;
  return `k${String(keys)}`;
}

function reply(parts: MessagePart[], state: ChatMessage['state']): ChatMessage {
  return {
    key: key(), role: 'assistant', parts, state, note: null, nodeId: null, parentId: null, feedback: null, ratingError: null, next: null, request: null, startedAt: 0, endedAt: null,
  };
}

const streaming = (parts: MessagePart[]): ChatMessage => reply(parts, 'streaming');
const tools = (steps: ToolStep[]): MessagePart => ({ type: 'tools', key: key(), steps });
const thought = (value: string): MessagePart => ({ type: 'thinking', key: key(), text: value });
const text = (value: string): MessagePart => ({ type: 'text', key: key(), text: value });
interface Call { id: string; name: string; input: Record<string, unknown>; result: Record<string, unknown> }
const running = (step: Call): ToolStep => ({ id: step.id, name: step.name, state: 'running', input: { ...step.input }, result: null });
const done = (step: Call): ToolStep => ({ ...running(step), state: 'done', result: { ...step.result } });

it('says Thinking… before anything arrives, and nothing while a step runs, thinking streams or text streams', () => {
  expect(liveLine(streaming([]))).toBe('Thinking…');
  expect(liveLine(streaming([tools([running(SALES_STEP)])]))).toBeNull();
  expect(liveLine(streaming([thought('Looking at the weekend')]))).toBeNull();
  expect(liveLine(streaming([text('So far')]))).toBeNull();
});

it('says Thinking… once every step has read, after a visual, and between steps', () => {
  expect(liveLine(streaming([tools([done(SALES_STEP)])]))).toBe('Thinking…');
  expect(liveLine(streaming([text('Here it is.'), { type: 'visual', key: key(), id: 'v1', visual: daily }]))).toBe('Thinking…');
  expect(liveLine(streaming([text('Let me look.'), tools([done(SALES_STEP), running({ ...SALES_STEP, id: 'toolu_test_0003' })])]))).toBeNull();
});

it('says nothing once the reply ends, however it ended', () => {
  for (const state of ['complete', 'stopped', 'failed'] as const) {
    expect(liveLine(reply([], state))).toBeNull();
    expect(liveLine(reply([tools([running(SALES_STEP)])], state))).toBeNull();
  }
});

it('says nothing for the person’s own message', () => {
  expect(liveLine({ ...streaming([]), role: 'user' })).toBeNull();
});
