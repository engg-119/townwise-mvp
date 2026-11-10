import { stepsOf, type ChatMessage } from './useTuningChat';

// The line in a streaming reply's timeline while nothing else shows that it is working: "Thinking…" before the first
// thinking text arrives and between steps. A running step is its own row ("Reading your sales for Oct 1 to Oct 31,
// 2026" in the timeline, "Read" once it has), thinking text and writing text show that they are streaming, and a
// reply that has ended has no live line.

export const THINKING = 'Thinking…';

export function liveLine(message: ChatMessage): string | null {
  if (message.role !== 'assistant' || message.state !== 'streaming') return null;
  const last = message.parts.at(-1);
  if (last?.type === 'text' || last?.type === 'thinking') return null;
  return stepsOf(message).some((step) => step.state === 'running') ? null : THINKING;
}
