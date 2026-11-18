// A server-sent events parser (the WHATWG "event stream" format), pure so it can be tested without a network.
// Text goes in as it arrives, in chunks of any size; whole events come out. `event`, `data` and `id` are read (a
// TownwiseAI turn numbers its events with `id`, so a reader resumes after the last one); `retry` is not, and a comment
// line (`: ping`) only keeps the connection open.

export interface SseEvent {
  /** The `event:` field, or `message` when the event had none. */
  readonly event: string;
  /** Every `data:` line of the event, joined with a newline. */
  readonly data: string;
  /**
   * The last `id:` the stream set, at or before this event (WHATWG's last event ID, which outlives its event); absent
   * while none is set, or after an empty `id:` cleared it.
   */
  readonly id?: string;
}

export interface SseParser {
  /** Feeds decoded text and returns the events it completed. */
  push(text: string): SseEvent[];
  /**
   * The stream ended. A CR held back as a possible CRLF ends its line after all; an event with no blank line after
   * it is discarded, as the WHATWG rules say, so a reply cut off mid-event never reads as finished.
   */
  end(): SseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let first = true;
  let eventType = '';
  let data: string[] = [];
  let lastId = '';

  function dispatch(out: SseEvent[]): void {
    if (data.length > 0) {
      const event = { event: eventType === '' ? 'message' : eventType, data: data.join('\n') };
      out.push(lastId === '' ? event : { ...event, id: lastId });
    }
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
    // An id holding NULL is ignored, as the WHATWG rules say.
    else if (field === 'id' && !value.includes('\u0000')) lastId = value;
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
      // Only a line with its end is a line; a blank one dispatches the event before it.
      if (buffer.endsWith('\r')) line(buffer.slice(0, -1), out);
      buffer = '';
      eventType = '';
      data = [];
      lastId = '';
      return out;
    },
  };
}
