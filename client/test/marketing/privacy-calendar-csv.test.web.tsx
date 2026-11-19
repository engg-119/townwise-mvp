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

test('Sorting bookings: titles without emails or phones, dates and hours go to Anthropic on import where TownwiseAI works on its own, or on a press whose labels wait for a confirm', () => {
  renderPrivacy();
  const sorting = item('Your organization and team', 'Sorting bookings with TownwiseAI.');
  expect(sorting).toContain('Townwise sends that calendar’s event titles, with email addresses and phone numbers removed, and their dates and hours to Anthropic, never the calendar’s name or anything else from the file.');
  // D59 slice 2: on import, with no press, unless a switch is off or staff open as admin imported it, with Undo.
  expect(sorting).toContain('Where TownwiseAI works on its own for your organization (an org admin can turn it off on the TownwiseAI page), and unless an org admin turned off sending your calendars’ titles to TownwiseAI there, Townwise does this once for each calendar file when it is imported, with no press, except a file Townwise staff import with your organization open as its admin.');
  expect(sorting).toContain('never changes a label a person set');
  // A press, a person's label or a confirm first, even during the sort, keeps TownwiseAI's labels and confirm off it.
  expect(sorting).toContain('If someone on your team sorts, labels or confirms that calendar first, even while TownwiseAI is sorting it, TownwiseAI leaves the calendar to them and keeps none of its own labels.');
  expect(sorting).toContain('leaves the calendar waiting for Use for forecasts, or not sorted when no label is left');
  expect(sorting).toContain('one change with Undo, which removes the labels and notes it added that nobody changed since');
  expect(sorting).toContain('Otherwise, on a calendar file’s page in Your data, an org admin can press Sort with TownwiseAI, and Townwise sends them once each time it is pressed.');
  expect(sorting).toContain('Townwise staff with your organization open as its admin can’t press it.');
  expect(sorting).toContain('The labels a press suggests change nothing until an org admin confirms them with Use for forecasts');
  expect(sorting).toContain('Each sort uses your organization’s monthly TownwiseAI budget.');
  expect(sorting).not.toContain('Only then');
  const anthropic = item('Who else sees it', 'Anthropic,');
  expect(anthropic).toContain('the calendar files it sorts when they are imported (see Sorting bookings with TownwiseAI), nothing is sent to Anthropic unless you use it');
  expect(anthropic).toContain('When a calendar file is sorted, on its own when it is imported where TownwiseAI works on its own or when an org admin presses Sort with TownwiseAI, Anthropic receives that calendar’s event titles, with email addresses and phone numbers removed, and their dates and hours, once each time, never the calendar’s name (see Sorting bookings with TownwiseAI).');
  const changes = item('Your organization and team', 'Changes TownwiseAI makes.');
  expect(changes).toContain('and from a calendar file you import (labels for its events, and notes for its upcoming buyouts and parties; see Sorting bookings with TownwiseAI)');
  expect(screen.getByRole('main').textContent).not.toMatch(/—/);
});
