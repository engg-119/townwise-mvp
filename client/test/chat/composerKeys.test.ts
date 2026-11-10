import { composerKey, EXAMPLE_MS, nextExample } from '../../src/chat/composerKeys';

function key(name: string, extra: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
  return { key: name, shiftKey: false, isComposing: false, ...extra };
}

function idle(draft: string, example: string | null = null) {
  return { draft, canSend: draft.trim() !== '', streaming: false, example };
}

it('Enter sends, Shift+Enter and composing keys do nothing, Enter while streaming does nothing', () => {
  expect(composerKey(key('Enter'), idle('hi'))).toBe('send');
  expect(composerKey(key('Enter', { shiftKey: true }), idle('hi'))).toBe('none');
  expect(composerKey(key('Enter', { isComposing: true }), idle('hi'))).toBe('none');
  expect(composerKey(key('Enter', { keyCode: 229 }), idle('hi'))).toBe('none');
  expect(composerKey(key('Enter'), { ...idle('hi'), streaming: true })).toBe('none');
});

it('Enter with nothing to send does nothing', () => {
  expect(composerKey(key('Enter'), idle(''))).toBe('none');
});

it('Tab accepts the example only in an empty composer, so it is never a keyboard trap', () => {
  expect(composerKey(key('Tab'), idle('', 'How did last week go?'))).toBe('accept_example');
  expect(composerKey(key('Tab'), idle('x', 'How did last week go?'))).toBe('none');
  expect(composerKey(key('Tab', { shiftKey: true }), idle('', 'How did last week go?'))).toBe('none');
  expect(composerKey(key('Tab'), idle('', null))).toBe('none');
  expect(composerKey(key('Tab', { isComposing: true }), idle('', 'How did last week go?'))).toBe('none');
});

it('examples advance every 4.2 seconds and wrap', () => {
  expect(EXAMPLE_MS).toBe(4200);
  expect(nextExample(0, 3)).toBe(1);
  expect(nextExample(2, 3)).toBe(0);
  expect(nextExample(0, 0)).toBe(0);
});
