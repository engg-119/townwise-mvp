import { createSseParser, type SseEvent } from '../../src/api/sse';

function parse(chunks: readonly string[]): SseEvent[] {
  const parser = createSseParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

const STREAM = [
  'event: conversation\ndata: {"id":"c1","title":"Closed"}\n\n',
  ': ping\n\n',
  'event: text\ndata: {"delta":"Héllo ☕"}\n\n',
  'event: done\ndata: {"stopReason":"end_turn","costUsd":0.01}\n\n',
].join('');

const EVENTS: SseEvent[] = [
  { event: 'conversation', data: '{"id":"c1","title":"Closed"}' },
  { event: 'text', data: '{"delta":"Héllo ☕"}' },
  { event: 'done', data: '{"stopReason":"end_turn","costUsd":0.01}' },
];

test('reads events in one chunk and skips the ping comment', () => {
  expect(parse([STREAM])).toEqual(EVENTS);
});

test('an event split across chunks at any point reads the same', () => {
  for (let at = 0; at <= STREAM.length; at += 1) {
    expect(parse([STREAM.slice(0, at), STREAM.slice(at)])).toEqual(EVENTS);
  }
  expect(parse(Array.from({ length: STREAM.length }, (_, index) => STREAM.charAt(index)))).toEqual(EVENTS);
});

test('returns each event as soon as its blank line arrives', () => {
  const parser = createSseParser();
  expect(parser.push('event: text\ndata: {"delta":"a"}\n')).toEqual([]);
  expect(parser.push('\nevent: text\ndata: {"delta"')).toEqual([{ event: 'text', data: '{"delta":"a"}' }]);
  expect(parser.push(':"b"}\n\n')).toEqual([{ event: 'text', data: '{"delta":"b"}' }]);
});

test('joins multi-line data with newlines', () => {
  expect(parse(['data: one\ndata: two\ndata:\ndata: three\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo\n\nthree' }]);
});

test('an event with no blank line after it is discarded when the stream ends', () => {
  expect(parse(['event: done\ndata: {"stopReason":"end_turn"}'])).toEqual([]);
  expect(parse(['event: done\ndata: {}\n'])).toEqual([]);
  expect(parse(['data: 1\r'])).toEqual([]);
  expect(parse(['event: text\ndata: 1\n\nevent: done\ndata: {}\n'])).toEqual([{ event: 'text', data: '1' }]);
});

test('reads CRLF and CR line ends, including a CRLF split between chunks', () => {
  expect(parse(['event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r'])).toEqual([
    { event: 'a', data: '1' },
    { event: 'b', data: '2' },
  ]);
  expect(parse(['event: a\r', '\ndata: 1\r', '\n\r', '\n'])).toEqual([{ event: 'a', data: '1' }]);
  // A CR at the very end still ends its line, here the blank one.
  expect(parse(['data: 1\r\r'])).toEqual([{ event: 'message', data: '1' }]);
});

test('field rules: one leading space is dropped, no colon means an empty value, unknown fields and empty events are ignored', () => {
  expect(parse(['data:no-space\n\n'])).toEqual([{ event: 'message', data: 'no-space' }]);
  expect(parse(['data:  two spaces\n\n'])).toEqual([{ event: 'message', data: ' two spaces' }]);
  expect(parse(['data\n\n'])).toEqual([{ event: 'message', data: '' }]);
  expect(parse(['retry: 1000\nevent: text\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  expect(parse([': ping\n\n: ping\n\n'])).toEqual([]);
});

test('a byte order mark at the start is ignored', () => {
  expect(parse(['﻿', 'event: text\ndata: 1\n\n'])).toEqual([{ event: 'text', data: '1' }]);
});

test('id: an event carries the last id the stream set, which outlives its event; an empty id clears it, one with NULL is ignored', () => {
  expect(parse(['id: 1\nevent: conversation\ndata: {}\n\nid: 2\nevent: text\ndata: a\n\n'])).toEqual([
    { event: 'conversation', data: '{}', id: '1' },
    { event: 'text', data: 'a', id: '2' },
  ]);
  // A block with no data dispatches nothing but still sets the id the next event carries.
  expect(parse(['id: 7\nretry: 1000\nevent: text\n\ndata: x\n\ndata: y\n\n'])).toEqual([
    { event: 'message', data: 'x', id: '7' },
    { event: 'message', data: 'y', id: '7' },
  ]);
  expect(parse(['id: 3\ndata: x\n\nid\ndata: y\n\n'])).toEqual([{ event: 'message', data: 'x', id: '3' }, { event: 'message', data: 'y' }]);
  expect(parse(['id: 4\ndata: x\n\nid: 5\u0000\ndata: y\n\n'])).toEqual([
    { event: 'message', data: 'x', id: '4' },
    { event: 'message', data: 'y', id: '4' },
  ]);
  // An id split across chunks reads whole.
  expect(parse(['id: 1', '2\nevent: done\ndata: {}\n', '\n'])).toEqual([{ event: 'done', data: '{}', id: '12' }]);
});
