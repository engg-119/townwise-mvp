import { toolLine, type ToolContext } from './tools';
import { stepsOf, type ChatMessage } from './useTuningChat';

// The line under a reply while it streams (owner decision 4): the running step's sentence from the tool table
// ("Reading your sales for Oct 1 to Oct 31, 2026…"), "TownwiseAI is thinking…" before anything arrives and between
// steps, and nothing while text is being written (the caret shows that) or once the reply has ended.

export const THINKING = 'TownwiseAI is thinking…';

export function liveLine(message: ChatMessage, ctx: ToolContext): string | null {
  if (message.role !== 'assistant' || message.state !== 'streaming') return null;
  if (message.parts.at(-1)?.type === 'text') return null;
  const running = stepsOf(message).filter((step) => step.state === 'running').at(-1);
  return running === undefined ? THINKING : `${toolLine(running, ctx).sentence}…`;
}
