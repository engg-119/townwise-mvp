// The composer's web keys as a pure function (spec P25): Enter sends, Shift+Enter is a new line, nothing happens
// while an input method composes, and Tab in an empty composer accepts the shown example. Tab with text moves focus
// as usual, so the composer is never a keyboard trap.

export const EXAMPLE_MS = 4200;

export type ComposerKeyAction = 'send' | 'accept_example' | 'none';

export function composerKey(
  event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number },
  state: { draft: string; canSend: boolean; streaming: boolean; example: string | null },
): ComposerKeyAction {
  if (event.isComposing || event.keyCode === 229) return 'none';
  if (event.key === 'Enter') return !event.shiftKey && state.canSend && !state.streaming ? 'send' : 'none';
  if (event.key === 'Tab') return !event.shiftKey && state.draft === '' && state.example !== null ? 'accept_example' : 'none';
  return 'none';
}

export function nextExample(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}
