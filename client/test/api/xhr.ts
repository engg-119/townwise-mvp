import type { XhrLike } from '../../src/api/client';

// A fake XMLHttpRequest for the upload transport: each request is recorded, and the test answers it (`respond`),
// fails it (`fail`), or reports bytes sent (`progress`).

export class FakeXhr implements XhrLike {
  method = '';
  url = '';
  readonly headers: Record<string, string> = {};
  withCredentials = false;
  body: Blob | null = null;
  status = 0;
  responseText = '';
  aborted = false;
  private responseHeaders = '';
  private readonly listeners = new Map<string, (() => void)[]>();
  private readonly progressListeners: ((event: { loaded: number }) => void)[] = [];
  readonly upload = {
    addEventListener: (_type: 'progress', listener: (event: { loaded: number }) => void): void => { this.progressListeners.push(listener); },
  };

  private readonly onSend: (xhr: FakeXhr) => void;

  constructor(onSend: (xhr: FakeXhr) => void) {
    this.onSend = onSend;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  addEventListener(type: 'load' | 'error' | 'abort', listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  send(body: Blob): void {
    this.body = body;
    this.onSend(this);
  }

  abort(): void {
    this.aborted = true;
    this.fire('abort');
  }

  progress(loaded: number): void {
    for (const listener of this.progressListeners) listener({ loaded });
  }

  respond(status: number, body?: unknown, headers: Readonly<Record<string, string>> = {}): void {
    this.status = status;
    this.responseText = body === undefined ? '' : JSON.stringify(body);
    this.responseHeaders = Object.entries({ 'content-type': 'application/json', ...headers }).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    this.fire('load');
  }

  fail(): void {
    this.fire('error');
  }

  private fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

/** A factory for createApiClient's `xhr`, and every request it made. */
export function fakeXhrs(onSend: (xhr: FakeXhr) => void = () => undefined): { make: () => FakeXhr; all: FakeXhr[] } {
  const all: FakeXhr[] = [];
  return {
    all,
    make: () => {
      const xhr = new FakeXhr(onSend);
      all.push(xhr);
      return xhr;
    },
  };
}
