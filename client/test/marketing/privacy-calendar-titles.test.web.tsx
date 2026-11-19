import { cleanup, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

// The privacy page's drafted words on the location calendars' event titles in TownwiseAI's weekly suggestions (OpenSpec
// change calendar-event-suggestions, task 9.1), awaiting the owner: what is sent (titles, dates and hours of the next 3
// months, with email addresses and phone numbers removed, never a calendar's name), to whom (Anthropic, which doesn't
// train on it), how often (weekly), who can turn it off (an org admin), that following a note's event uses no AI, that
// a calendar added or connected on a screen without the new words sends no titles until it is added or connected again, and the
// Limited Use statement is unchanged.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => { cleanup(); });

function renderPrivacy(): void {
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
}

function item(region: string, start: string): string {
  const found = within(screen.getByRole('region', { name: region })).getAllByRole('listitem').find((each) => each.textContent.startsWith(start));
  if (found === undefined) throw new Error(`no item ${start}`);
  return found.textContent;
}

test('Your calendars: TownwiseAI reads them when asked and weekly, and a note made from an event keeps which event, never its title', () => {
  renderPrivacy();
  const calendars = item('Your organization and team', 'Your calendars.');
  expect(calendars).toContain('Everyone on your organization’s team can see the calendars and their events, and TownwiseAI reads them when you ask about your bookings and once a week for its suggestions (see TownwiseAI’s weekly suggestions, below).');
  expect(calendars).toContain('A note you make from an event with Make a note keeps which event it came from (the calendar, the event’s ID from that calendar, and its dates and hours, never its title), so Townwise can suggest moving or deleting the note when the event moves or leaves the calendar.');
  expect(calendars).toContain('Removing a calendar deletes its events, not the notes you made from them.');
});

test('Google calendars: both ways titles reach Anthropic, and the older-calendar rule is told once, under weekly suggestions', () => {
  renderPrivacy();
  const google = item('Your organization and team', 'Google calendars.');
  expect(google).toContain('TownwiseAI reads their names and their events’ titles when you ask about your bookings, and once a week reads their events’ titles, dates and hours, never their names, for its suggestions (see TownwiseAI’s weekly suggestions), so they reach Anthropic, which doesn’t train on them.');
  expect(google).not.toContain('If a Google calendar was connected before');
  expect(google).not.toContain('when you ask about your bookings, so they reach Anthropic');
});

test('weekly suggestions: what they read from the calendars, the org admin’s switch, older calendars left out, and follow-ups with no AI', () => {
  renderPrivacy();
  const weekly = item('Your organization and team', 'TownwiseAI’s weekly suggestions.');
  expect(weekly).toContain('It also reads the titles, dates and hours of the next 3 months of events on the location’s own calendars, with email addresses and phone numbers removed and never a calendar’s name, to spot private events, such as a party or a buyout, and ask whether each takes the whole restaurant. An org admin can turn this part off on its own on the TownwiseAI page.');
  expect(weekly).toContain('A calendar added or connected on a screen that did not yet say this sends no titles to the weekly suggestions until it is added or connected again.');
  expect(weekly).not.toContain('November 18, 2026');
  expect(weekly).toContain('When an event you made a note from moves or leaves your calendar, Townwise suggests moving or deleting the note. That comparison runs on our server with no AI, sends nothing to Anthropic, and runs even with weekly suggestions off.');
  expect(weekly).toContain('A suggestion from your calendars keeps the event’s ID, dates and hours, never its title, and its card reads the title from your calendar each time it shows.');
});

test('Anthropic receives the titles weekly, never a calendar’s name; the Limited Use statement is unchanged; the date', () => {
  renderPrivacy();
  const anthropic = item('Who else sees it', 'Anthropic,');
  expect(anthropic).toContain('its notes and business rules for those days as your team wrote them, the suggestions it made before and, unless an org admin turns that off too, the titles, dates and hours of the next 3 months of events on the location’s own calendars, with email addresses and phone numbers removed; never your team’s names or email addresses (apart from any written in a note, a rule or an event’s title), a calendar’s name, or your organization’s name. The weekly reading doesn’t send your location’s name either, though an event town research found can name your restaurant or another public business.');
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Google user data. Townwise’s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.');
  expect(text).toContain('Effective November 5, 2026. Last updated November 19, 2026.');
  expect(text).not.toMatch(/\u2014/);
});
