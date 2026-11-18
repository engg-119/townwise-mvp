import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => { cleanup(); });

test('says Townwise keeps the dates each signed-in person used the app, for 180 days, in the short version and with sign-in, and deletes them with the account', () => {
  const auth = fakeAuth({ status: 'signedOut' });
  window.history.replaceState(null, '', '/privacy');
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({
          _layout: () => <AuthProvider auth={auth}><RootStack /></AuthProvider>,
          '(marketing)/_layout': MarketingLayout,
          '(marketing)/privacy': Privacy,
        })}
        location="/privacy"
      />
    </Head.Provider>,
  );
  const text = screen.getByRole('main').textContent;
  const line = 'Townwise keeps the dates on which each signed-in person used the app, for 180 days, to see whether the product is used. It keeps the date only: not the time, the page or what you did. Townwise staff see it by organization.';
  // In The short version, after the telemetry line, and again in What we keep when you sign in (staff-overview design decision 6).
  expect(text.split(line)).toHaveLength(3);
  expect(text).toContain('The Townwise app sends no telemetry');
  expect(text).toContain('your place on a team, the dates on which you used the app and your TownwiseAI conversations');
});
