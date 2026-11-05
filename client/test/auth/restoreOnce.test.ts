import { ApiError } from '../../src/api/client';
import { restoreOnce } from '../../src/auth/restoreOnce';
import { fakeAuth } from '../helpers/fakes';

test('two calls with the same auth restore once', () => {
  const restore = jest.fn(() => Promise.resolve());
  const auth = fakeAuth({ status: 'signedOut' }, { restore });
  restoreOnce(auth);
  restoreOnce(auth);
  expect(restore).toHaveBeenCalledTimes(1);
});

test('a second auth object gets its own restore', () => {
  const first = jest.fn(() => Promise.resolve());
  const second = jest.fn(() => Promise.resolve());
  restoreOnce(fakeAuth({ status: 'signedOut' }, { restore: first }));
  restoreOnce(fakeAuth({ status: 'signedOut' }, { restore: second }));
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test('restores whatever the status is', () => {
  const restore = jest.fn(() => Promise.resolve());
  restoreOnce(fakeAuth({ status: 'unreachable', error: new ApiError('network', 'down') }, { restore }));
  expect(restore).toHaveBeenCalledTimes(1);
});
