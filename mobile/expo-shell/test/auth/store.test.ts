import { createAuthStore, routeFor } from '../../src/auth/store';
import { ApiError } from '../../src/api/client';

const USER = { id: 'u1', email: ['a', 'example.com'].join('@') };

test('subscribe and unsubscribe', () => {
  const store = createAuthStore();
  const listener = jest.fn();
  const unsubscribe = store.subscribe(listener);
  store.set({ status: 'signedOut' });
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  store.set({ status: 'restoring' });
  expect(listener).toHaveBeenCalledTimes(1);
});

test('routeFor for every status', () => {
  expect(routeFor({ status: 'signedIn', user: USER })).toBe('/');
  expect(routeFor({ status: 'mfaRequired', mfaToken: 'mfa-1' })).toBe('/totp');
  expect(routeFor({ status: 'signedOut' })).toBe('/sign-in');
  expect(routeFor({ status: 'restoring' })).toBeNull();
  expect(routeFor({ status: 'unreachable', error: new ApiError('network', 'down') })).toBeNull();
});
