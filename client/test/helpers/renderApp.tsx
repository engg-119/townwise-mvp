import { renderRouter } from 'expo-router/testing-library';

import type { Auth } from '../../src/auth/auth';
import { appRoutes, seededRoot } from './app';
import { fakeAuth } from './fakes';
import { EMAIL, type FakePortalApi } from './portal';

// The whole app on native at `path`, signed in, with the portal answering from `api`. Test files that use it
// mock @react-native-google-signin/google-signin and expo-splash-screen, as test/app/routing.test.native.tsx does.
export async function renderApp(path: string, api: FakePortalApi, overrides?: Partial<Auth>) {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api, ...overrides });
  const router = await renderRouter(appRoutes(seededRoot(auth)), { initialUrl: path });
  return { router, auth };
}
