jest.mock('expo/fetch', () => ({ fetch: jest.fn(() => Promise.resolve({ status: 200 })) }));

import { fetch as expoFetch } from 'expo/fetch';

import { streamFetch } from '../../src/api/streamFetch';

test('native streams go through expo/fetch, which exposes the body as a stream', async () => {
  const init: RequestInit = { method: 'POST', credentials: 'omit' };
  await streamFetch('https://api.example.com/x', init);
  expect(jest.mocked(expoFetch).mock.calls).toEqual([['https://api.example.com/x', init]]);
});
