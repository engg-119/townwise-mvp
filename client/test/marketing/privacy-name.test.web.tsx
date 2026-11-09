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

test('says what Townwise keeps of your name and of reply ratings, and that both go with your account or conversation', () => {
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
  expect(text).toContain('Your name. If you tell Townwise what to call you, we keep that name with your account and use it only to greet you in the app. Until you do, we use the first name from your access request, if you sent one. Change or clear it in Settings. It’s deleted with your account.');
  expect(text).toContain('If you rate a reply, we keep the rating with the conversation: helpful or not, and a reason you pick from a short list. We keep them until your account or your organization is deleted.');
  expect(text).toContain('your account record, your name, sessions');
});
