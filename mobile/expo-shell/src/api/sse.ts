// A server-sent events parser (the WHATWG "event stream" format), pure so it can be tested without a network.
// Text goes in as it arrives, in chunks of any size; whole events come out. Only `event` and `data` are read:
// the tuning chat sends no `id` or `retry`, and a comment line (`: ping`) only keeps the connection open.

export interface SseEvent {
  /** The `event:` field, or `message` when the event had none. */
  readonly event: string;
  /** Every `data:` line of the event, joined with a newline. */
  readonly data: string;
}

export interface SseParser {
  /** Feeds decoded text and returns the events it completed. */
  push(text: string): SseEvent[];
  /** The stream ended. Completes a last event that had no blank line after it. */
  end(): SseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let first = true;
  let eventType = '';
  let data: string[] = [];

  function dispatch(out: SseEvent[]): void {
    if (data.length > 0) out.push({ event: eventType === '' ? 'message' : eventType, data: data.join('\n') });
    eventType = '';
    data = [];
  }

  function line(text: string, out: SseEvent[]): void {
    if (text === '') {
      dispatch(out);
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') data.push(value);
  }

  return {
    push(text) {
      buffer += text;
      if (first && buffer !== '') {
        first = false;
        if (buffer.startsWith('﻿')) buffer = buffer.slice(1);
      }
      const out: SseEvent[] = [];
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (char !== '\n' && char !== '\r') continue;
        // A CR at the end of the text may be the first half of a CRLF; wait for the next chunk.
        if (char === '\r' && index === buffer.length - 1) break;
        line(buffer.slice(start, index), out);
        if (char === '\r' && buffer[index + 1] === '\n') index += 1;
        start = index + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    end() {
      const out: SseEvent[] = [];
      const rest = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      buffer = '';
      if (rest !== '') line(rest, out);
      dispatch(out);
      return out;
    },
  };
}
