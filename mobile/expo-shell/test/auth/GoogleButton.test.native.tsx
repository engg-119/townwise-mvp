jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';

import { GoogleButton, resetGoogleButtonState } from '../../src/auth/GoogleButton';

const google = {
  webClientId: '123-abc.apps.googleusercontent.com',
  iosClientId: '456-def.apps.googleusercontent.com',
};

beforeEach(() => {
  resetGoogleButtonState();
  jest.clearAllMocks();
});

test('the idToken goes to onIdToken and the Google SDK is signed out', async () => {
  jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'id-1', user: { id: 'g', email: 'a@b.c' } } } as never);
  jest.mocked(GoogleSignin.signOut).mockResolvedValue(null);
  const onIdToken = jest.fn();
  const onError = jest.fn();
  await render(<GoogleButton google={google} onIdToken={onIdToken} onError={onError} />);
  await fireEvent.press(screen.getByText('Sign in with Google'));
  await waitUntil(() => onIdToken.mock.calls.length === 1);
  expect(onIdToken).toHaveBeenCalledWith('id-1');
  expect(GoogleSignin.signOut).toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

test('cancel is silent', async () => {
  jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'cancelled', data: null } as never);
  const onIdToken = jest.fn();
  const onError = jest.fn();
  await render(<GoogleButton google={google} onIdToken={onIdToken} onError={onError} />);
  await fireEvent.press(screen.getByText('Sign in with Google'));
  await Promise.resolve();
  await Promise.resolve();
  expect(onIdToken).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

test('Play services error mapped', async () => {
  jest.mocked(GoogleSignin.signIn).mockRejectedValue({ code: statusCodes.PLAY_SERVICES_NOT_AVAILABLE });
  const onError = jest.fn<undefined, [string]>();
  await render(<GoogleButton google={google} onIdToken={jest.fn()} onError={onError} />);
  await fireEvent.press(screen.getByText('Sign in with Google'));
  await waitUntil(() => onError.mock.calls.length === 1);
  expect(onError.mock.calls[0]?.[0]).not.toBe('');
});

test('renders nothing when unconfigured', async () => {
  const view = await render(<GoogleButton google={null} onIdToken={jest.fn()} onError={jest.fn()} />);
  expect(view.toJSON()).toBeNull();
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error('timed out');
}
