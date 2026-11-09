import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useRefreshable } from '../../../src/portal/console/useRefreshable';
import { deferred, offline } from '../../helpers/portal';

// useRefreshable (src/portal/console/useRefreshable.ts): only the newest read counts. An answer that lands after a
// newer refresh or reload began is dropped, success or failure, and resolves to null.

type Pending = ReturnType<typeof deferred<string>>;

/** A loader whose first call answers `initial` and whose later calls wait in `pending` until the test settles them. */
function loader(): { load: () => Promise<string>; pending: Pending[] } {
  const pending: Pending[] = [];
  let calls = 0;
  const load = (): Promise<string> => {
    calls += 1;
    if (calls === 1) return Promise.resolve('initial');
    const next = deferred<string>();
    pending.push(next);
    return next.promise;
  };
  return { load, pending };
}

function at(pending: Pending[], index: number): Pending {
  const found = pending[index];
  if (found === undefined) throw new Error(`no read ${String(index)}`);
  return found;
}

async function ready(load: () => Promise<string>) {
  const hook = await renderHook(() => useRefreshable(load));
  await waitFor(() => { expect(hook.result.current.state).toEqual({ status: 'ready', data: 'initial' }); });
  return hook;
}

test('an older refresh that lands after a newer one is dropped', async () => {
  const { load, pending } = loader();
  const { result } = await ready(load);
  let older: Promise<unknown> = Promise.resolve();
  let newer: Promise<unknown> = Promise.resolve();
  await act(async () => {
    older = result.current.refresh();
    newer = result.current.refresh();
    await Promise.resolve();
  });
  await act(async () => { at(pending, 1).resolve('newer'); await newer; });
  expect(result.current.state).toEqual({ status: 'ready', data: 'newer' });
  await act(async () => { at(pending, 0).resolve('older'); await older; });
  expect(result.current.state).toEqual({ status: 'ready', data: 'newer' });
  await expect(older).resolves.toBeNull();
});

test('an older refresh that fails after a newer one went through sets no error', async () => {
  const { load, pending } = loader();
  const { result } = await ready(load);
  let older: Promise<unknown> = Promise.resolve();
  let newer: Promise<unknown> = Promise.resolve();
  await act(async () => {
    older = result.current.refresh();
    newer = result.current.refresh();
    await Promise.resolve();
  });
  await act(async () => { at(pending, 1).resolve('newer'); await newer; });
  await act(async () => { at(pending, 0).reject(offline()); await older; });
  expect(result.current.refreshError).toBeNull();
  expect(result.current.state).toEqual({ status: 'ready', data: 'newer' });
  await expect(older).resolves.toBeNull();
});

test('the newest refresh still reports its own failure', async () => {
  const { load, pending } = loader();
  const { result } = await ready(load);
  let only: Promise<unknown> = Promise.resolve();
  await act(async () => { only = result.current.refresh(); await Promise.resolve(); });
  const error = offline();
  await act(async () => { at(pending, 0).reject(error); await only; });
  await expect(only).resolves.toEqual({ error });
  expect(result.current.refreshError).toBe(error);
  expect(result.current.state).toEqual({ status: 'ready', data: 'initial' });
});
