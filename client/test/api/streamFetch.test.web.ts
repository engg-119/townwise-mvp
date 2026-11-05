jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

import { fetch as expoFetch } from 'expo/fetch';

import { streamFetch } from '../../src/api/streamFetch';

test('web streams use the browser’s own fetch, called on globalThis', async () => {
  const original = globalThis.fetch;
  const seen: unknown[] = [];
  globalThis.fetch = function fetch(this: unknown, input: RequestInfo | URL) {
    seen.push(this, input);
    return Promise.resolve({ status: 200 } as Response);
  };
  try {
    await streamFetch('https://api.example.com/x', { method: 'POST', credentials: 'include' });
    expect(seen).toEqual([globalThis, 'https://api.example.com/x']);
    expect(jest.mocked(expoFetch)).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = original;
  }
});
