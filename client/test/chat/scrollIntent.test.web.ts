import { fireEvent } from '@testing-library/react';

import { watchScrollIntent } from '../../src/chat/scrollIntent';

// spec P25 Scrolling: only a scroll the person makes unpins the thread, so on web their input is heard first.

function must<T>(value: T | null): T {
  if (value === null) throw new Error('missing');
  return value;
}

function setup(): { node: HTMLElement; button: HTMLElement; field: HTMLElement; outside: HTMLElement; at: { now: number }; intent: ReturnType<typeof watchScrollIntent> } {
  document.body.innerHTML = '<div id="thread"><div><div role="button" tabindex="0">Working for 3s</div><textarea></textarea></div></div><textarea id="composer"></textarea>';
  const node = must(document.getElementById('thread'));
  const at = { now: 1000 };
  return {
    node,
    button: must(node.querySelector<HTMLElement>('[role="button"]')),
    field: must(node.querySelector('textarea')),
    outside: must(document.getElementById('composer')),
    at,
    intent: watchScrollIntent(node, () => at.now),
  };
}

test('a wheel counts while its smooth scroll can run, then no longer', () => {
  const { node, at, intent } = setup();
  expect(intent.person()).toBe(false);
  fireEvent.wheel(node, { deltaY: -40 });
  expect(intent.person()).toBe(true);
  at.now += 399;
  expect(intent.person()).toBe(true);
  at.now += 2;
  expect(intent.person()).toBe(false);
  intent.stop();
});

test('a finger dragging counts, and its momentum after it lifts; a tap does not', () => {
  const { node, button, at, intent } = setup();
  fireEvent.touchStart(button);
  fireEvent.touchEnd(button);
  expect(intent.person()).toBe(false);
  fireEvent.touchStart(node);
  fireEvent.touchMove(node);
  expect(intent.person()).toBe(true);
  at.now += 5000;
  expect(intent.person()).toBe(true);
  fireEvent.touchEnd(node);
  at.now += 999;
  expect(intent.person()).toBe(true);
  at.now += 2;
  expect(intent.person()).toBe(false);
  intent.stop();
});

test('the scrollbar held counts; a click on the thread’s content does not', () => {
  const { node, button, intent } = setup();
  fireEvent.pointerDown(button, { pointerType: 'mouse' });
  fireEvent.pointerUp(button, { pointerType: 'mouse' });
  expect(intent.person()).toBe(false);
  fireEvent.pointerDown(node, { pointerType: 'mouse' });
  expect(intent.person()).toBe(true);
  fireEvent.pointerUp(document.body, { pointerType: 'mouse' });
  expect(intent.person()).toBe(true);
  intent.stop();
});

test('a scroll key in the thread counts; Space on a button, keys in a field and keys outside the thread do not', () => {
  const { node, button, field, outside, intent } = setup();
  fireEvent.keyDown(button, { key: ' ' });
  fireEvent.keyDown(field, { key: 'ArrowUp' });
  fireEvent.keyDown(outside, { key: 'PageUp' });
  fireEvent.keyDown(node, { key: 'a' });
  expect(intent.person()).toBe(false);
  fireEvent.keyDown(button, { key: 'PageUp' });
  expect(intent.person()).toBe(true);
  intent.stop();
});

test('stop stops listening', () => {
  const { node, intent } = setup();
  intent.stop();
  fireEvent.wheel(node, { deltaY: -40 });
  expect(intent.person()).toBe(false);
});
