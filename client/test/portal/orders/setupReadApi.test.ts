import type { z } from 'zod';

import type { ApiClient, RequestOptions } from '../../../src/api/client';
import { fetchOrderSetup, readSetupWithAi, SETUP_READ_TIMEOUT_MS } from '../../../src/portal/orders/api';

// Reading the ordering setup with TownwiseAI (D41): the call and its answer's schema (the API's contract in
// api/README.md, Orders), and `canReadWithAi` on the setup. Synthetic names only.

function clientAnswering(answer: unknown): { api: ApiClient; calls: { path: string; opts: RequestOptions | undefined }[] } {
  const calls: { path: string; opts: RequestOptions | undefined }[] = [];
  const api: ApiClient = {
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      calls.push({ path, opts });
      return Promise.resolve(schema.parse(answer));
    },
    request: () => Promise.reject(new Error('unused')),
    stream: () => Promise.reject(new Error('unused')),
    logout: () => Promise.resolve(),
  };
  return { api, calls };
}

const READ = {
  kind: 'invoice',
  confidence: 'high',
  suppliers: [{ name: 'Sample Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: null, cutoffTime: null }] }],
  items: [{
    name: 'Sample IPA', supplier: 'Sample Brewery', category: 'draft', unit: 'kegs', servingsPerUnit: 124, servingsEstimated: true,
    dealSize: null, posNames: [], note: 'A half-barrel holds about 124 pints.', inFile: true,
  }],
  itemsCut: false,
  partial: false,
};

test('posts the source alone, waits 170 seconds, and passes the caller’s signal; answers the checked suggestions', async () => {
  const { api, calls } = clientAnswering({ read: READ });
  const controller = new AbortController();
  const read = await readSetupWithAi(api, 'l1', { type: 'file', kind: 'pdf', data: 'JVBERi0x' }, controller.signal);
  expect(read).toEqual(READ);
  expect(calls).toEqual([{
    path: '/api/org/locations/l1/orders/setup/read',
    opts: { method: 'POST', body: { source: { type: 'file', kind: 'pdf', data: 'JVBERi0x' } }, signal: controller.signal, timeoutMs: 170_000 },
  }]);
  expect(SETUP_READ_TIMEOUT_MS).toBe(170_000);
  await readSetupWithAi(api, 'l1', { type: 'text', text: 'Sample IPA, 1 keg' }, controller.signal);
  expect(calls[1]?.opts?.body).toEqual({ source: { type: 'text', text: 'Sample IPA, 1 keg' } });
});

test('an answer that carries a par or never run out drops them; one missing a field is not valid', async () => {
  const withPar = { read: { ...READ, items: [{ ...READ.items[0], par: 4, neverRunOut: true }] } };
  const read = await readSetupWithAi(clientAnswering(withPar).api, 'l1', { type: 'text', text: 'x' }, new AbortController().signal);
  expect(read.items[0]).not.toHaveProperty('par');
  expect(read.items[0]).not.toHaveProperty('neverRunOut');
  const broken = { read: { ...READ, items: [{ ...READ.items[0], inFile: undefined }] } };
  await expect(readSetupWithAi(clientAnswering(broken).api, 'l1', { type: 'text', text: 'x' }, new AbortController().signal)).rejects.toThrow();
});

test('the setup says whether TownwiseAI can read for it; an API before D41 reads as no', async () => {
  const base = { today: '2026-11-15', setup: null, coverage: null, itemCoverage: {}, counts: {}, itemsWithHistory: [] };
  expect((await fetchOrderSetup(clientAnswering({ ...base, canReadWithAi: true }).api, 'l1')).canReadWithAi).toBe(true);
  expect((await fetchOrderSetup(clientAnswering(base).api, 'l1')).canReadWithAi).toBe(false);
});
