import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

// The privacy page's drafted words on TownwiseAI's weekly suggestions (OpenSpec change weekly-forecast-suggestions,
// task 3.3), awaiting the owner: what they keep, what reaches Anthropic and what never does, and that an org admin can
// turn them off.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => { cleanup(); });

test('says what weekly suggestions keep and send to Anthropic, that an org admin can turn them off, and the date', () => {
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
  expect(text).toContain('Unless an org admin turns them off on the TownwiseAI page, once a week TownwiseAI reads the next 3 months of each location’s town calendar with that location’s notes and business rules, and suggests notes or business rules for those days.');
  // The location calendars' titles come between (calendar-event-suggestions; privacy-calendar-titles.test.web.tsx).
  expect(text).toContain('A suggestion changes nothing until an org admin accepts it');
  expect(text).toContain('Apart from TownwiseAI’s weekly suggestions, nothing is sent to Anthropic unless you use it');
  expect(text).toContain('how the location’s past holidays and town events went (as percentages and counts of days, never a sales figure)');
  // A note's detail and a rule's words go as written, so a name the team wrote there goes too (2026-11-17 review).
  // An owner-calendar event's title goes as written too (calendar-event-suggestions), with emails and phone numbers removed.
  expect(text).toContain('never your team’s names or email addresses (apart from any written in a note, a rule or an event’s title), a calendar’s name, or your organization’s or location’s name. Each week’s suggestions use your organization’s monthly TownwiseAI budget.');
  expect(text).toContain('Last updated November 18, 2026.');
});
