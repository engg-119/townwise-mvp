import { cleanup, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

// The privacy page's drafted words on calendar CSV exports and on sorting a calendar file's bookings with TownwiseAI
// (spec D58, OpenSpec change learn-from-calendar-bookings, design decision 14, task 10.2), awaiting the owner: a CSV
// export's titles, dates and hours are kept and its other columns never read or kept; Sort with TownwiseAI sends a file
// calendar's titles (emails and phone numbers removed), dates and hours to Anthropic once, on an org admin's press, never
// the calendar's name; and the labels change nothing until an org admin confirms them.

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

test('Your calendars: a CSV export’s titles, dates and hours are kept, and its other columns are never read or kept', () => {
  renderPrivacy();
  const calendars = item('Your organization and team', 'Your calendars.');
  expect(calendars).toContain('From a calendar exported as a CSV, Townwise keeps each event’s title, dates and hours and its ID, and uses its status only to leave out canceled events; it never reads or keeps the file’s other columns, such as descriptions, places, organizers or guests.');
});

test('Sorting bookings: titles without emails or phones, dates and hours go to Anthropic once on an org admin’s press, and labels wait for a confirm', () => {
  renderPrivacy();
  const sorting = item('Your organization and team', 'Sorting bookings with TownwiseAI.');
  expect(sorting).toContain('On a calendar file’s page in Your data, an org admin can press Sort with TownwiseAI. Only then, and once each time it is pressed, Townwise sends that calendar’s event titles, with email addresses and phone numbers removed, and their dates and hours to Anthropic, never the calendar’s name or anything else from the file');
  expect(sorting).toContain('Townwise staff with your organization open as its admin can’t press it.');
  expect(sorting).toContain('The labels it suggests change nothing until an org admin confirms them with Use for forecasts');
  expect(sorting).toContain('Each sort uses your organization’s monthly TownwiseAI budget.');
  const anthropic = item('Who else sees it', 'Anthropic,');
  expect(anthropic).toContain('When an org admin presses Sort with TownwiseAI on a calendar file, Anthropic receives that calendar’s event titles, with email addresses and phone numbers removed, and their dates and hours, once, never the calendar’s name (see Sorting bookings with TownwiseAI).');
  expect(screen.getByRole('main').textContent).not.toMatch(/—/);
});
