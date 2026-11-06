import { act, renderHook } from '@testing-library/react-native';

import { EMPTY_SNAPSHOT, useUploadQueue } from '../../../src/portal/files/uploadQueue';
import { ACCESS, meOf, viewAsMe } from '../../helpers/portal';
import { filesFake, LOCATION, sourceOf, type FilesFake } from './fakes';
import { portalWrapper } from './harness';

// useUploadQueue for a screen (storage2 15.3 step 7): under view-as no queue exists, so a drop sends nothing; as
// a member a drop uploads; and a new location stops the old location's queue.

let fake: FilesFake;
const advance = (ms: number): Promise<void> => act(() => jest.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  jest.useFakeTimers();
  fake = filesFake();
});

afterEach(() => {
  jest.useRealTimers();
});

test('under view-as a drop sends no request and the queue stays empty', async () => {
  const { result, unmount } = await renderHook(() => useUploadQueue(LOCATION), { wrapper: portalWrapper(fake, viewAsMe(ACCESS.admin)) });
  await advance(0);
  await act(async () => { result.current.add([sourceOf('a.csv', 4)]); await jest.advanceTimersByTimeAsync(0); });
  expect(fake.calls).toHaveLength(0);
  expect(fake.puts).toHaveLength(0);
  const { items, overall, importId, filesUnavailable, limits } = result.current;
  expect({ items, overall, importId, filesUnavailable, limits }).toEqual(EMPTY_SNAPSHOT);
  await unmount();
});

test('as a member a drop uploads, and moving to another location stops the old queue', async () => {
  const { result, rerender, unmount } = await renderHook(
    (props: { locationId: string }) => useUploadQueue(props.locationId),
    { wrapper: portalWrapper(fake, meOf(ACCESS.admin)), initialProps: { locationId: LOCATION } },
  );
  await advance(0);
  await act(async () => { result.current.add([sourceOf('a.csv', 8)]); await jest.advanceTimersByTimeAsync(0); });
  expect(fake.calls.filter((call) => call.method === 'POST' && call.path === '/files')).toHaveLength(1);
  expect(result.current.items.map((item) => item.state)).toEqual(['sending']);
  await rerender({ locationId: 'l2' });
  await advance(0);
  expect(fake.puts[0]?.signal?.aborted).toBe(true);
  expect(result.current.items).toEqual([]);
  await unmount();
});
