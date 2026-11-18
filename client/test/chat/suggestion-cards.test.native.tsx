jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AccessibilityInfo, Dimensions } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { fakeChatApi, noteOf, refusal, type FakeChatApi } from '../helpers/chat';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { serveAbout } from './about-fakes';

// The owner-calendar cards in P25's sheet on a phone (openspec change calendar-event-suggestions): the follow-ups of a
// note whose event moved or went in "Your calendar changed", before the suggestions; a spotted private event's two
// choices as a radio group with neither checked, a guest count prefilled from the event, and Accept disabled, saying
// why, until a choice is made; and the switch for reading the calendars' event titles. The fixture is the API's.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; suggestions: unknown[]; weeklySuggestions: Record<string, boolean> };
};

const EVENT_HEADING = 'A private event on Sat, Jul 11, 2026?';
const MOVE_HEADING = 'Move the note to Sat, Jul 25, 2026?';
const BUYOUT = 'The whole restaurant (a buyout)';
const ALONGSIDE = 'Alongside regular service';

afterEach(async () => {
  await cleanup();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
  jest.restoreAllMocks();
});

const WINDOW = Dimensions.get('window');

async function renderSheet(me: MeResponse, canChange: boolean): Promise<FakeChatApi> {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
  const chat = fakeChatApi();
  chat.panel = { ...fixture.panel, weeklySuggestions: { ...fixture.panel.weeklySuggestions, available: true, canChange } };
  serveAbout(chat);
  const role = me.access.state === 'member' ? me.access.role : 'member';
  await renderApp('/locations/l1/agent?panel=questions', fakePortalApi({ me, org: orgOf(role), fallback: chat }));
  // On a phone Home's link opens the row under the chips (the full-screen sheet is gone); its sections are the panel's.
  expect(await screen.findByTestId('agent-side')).toBeTruthy();
  return chat;
}

/** A card, by its question: the nearest element around its heading that holds its help line. */
function cardOf(heading: string, help: RegExp): ReturnType<typeof screen.getByRole> {
  let node = screen.getByRole('heading', { name: heading });
  while (node.parent !== null && within(node).queryAllByText(help).length === 0) node = node.parent;
  return node;
}

function acceptOf(card: ReturnType<typeof screen.getByRole>): ReturnType<typeof screen.getByRole> {
  return within(card).getByRole('button', { name: 'Accept' });
}

test('“Your calendar changed” comes first; members see the cards with no choice, count or buttons', async () => {
  await renderSheet(meOf(ACCESS.member), false);
  const side = screen.getByTestId('agent-side');
  await within(side).findByRole('heading', { name: 'Your calendar changed' });
  const headings = within(side).getAllByRole('heading').map((heading) => (heading.props as { children: unknown }).children);
  expect(headings.indexOf('Your calendar changed')).toBeLessThan(headings.indexOf('Suggested for the next 3 months'));
  expect(within(side).getByText('The private event on Sat, Jul 18 moved to Sat, Jul 25 on your calendar.')).toBeTruthy();
  expect(within(side).getByText('From your calendar: Private party, 40 guests, Sat, Jul 11, 6 pm to 10 pm')).toBeTruthy();
  expect(within(side).queryAllByRole('radio')).toHaveLength(0);
  expect(within(side).queryByRole('button', { name: 'Accept' })).toBeNull();
  expect(within(side).getByText('Reading event titles is on.')).toBeTruthy();
  expect(within(side).queryByRole('button', { name: 'Turn off reading event titles' })).toBeNull();
});

test('a spotted event’s choices are radios with neither checked, and Accept waits for one and, alongside, a count', async () => {
  const api = await renderSheet(meOf(ACCESS.admin), true);
  const accept = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c4/accept';
  api.respond[accept] = () => ({
    suggestion: { id: '0000000000000000000000c4', status: 'accepted' },
    note: noteOf({ kind: 'private_event', startDate: '2026-07-11', endDate: '2026-07-11', effect: 'more_guests', expectedGuests: 35, detail: null }, 'n9'),
    rule: null,
  });
  await screen.findByRole('heading', { name: EVENT_HEADING });
  const card = cardOf(EVENT_HEADING, /^Choose how this event runs/);
  // The group is a container, not one accessibility element, so each choice stays its own radio.
  expect(within(card).getByLabelText('How this event runs').props.role).toBe('radiogroup');
  expect(within(card).getAllByRole('radio')).toHaveLength(2);
  expect(within(card).getByRole('radio', { name: BUYOUT, checked: false })).toBeTruthy();
  expect(within(card).getByRole('radio', { name: ALONGSIDE, checked: false })).toBeTruthy();
  expect(acceptOf(card).props.accessibilityState).toMatchObject({ disabled: true });
  expect(within(card).getByText('Choose how this event runs to accept it. Dismiss and TownwiseAI won’t ask about this event again.')).toBeTruthy();
  const guests = within(card).getByLabelText('Guests');
  expect(guests.props.value).toBe('40');

  await fireEvent.press(within(card).getByRole('radio', { name: ALONGSIDE }));
  // The choice says what it does to the forecast, and the checked radio's hint says the same.
  expect(within(card).getByText('These guests add to the whole day’s total.')).toBeTruthy();
  expect(within(card).getByRole('radio', { name: ALONGSIDE, checked: true }).props.accessibilityHint).toBe('These guests add to the whole day’s total.');
  await fireEvent.press(within(card).getByRole('radio', { name: BUYOUT }));
  expect(within(card).getByRole('radio', { name: BUYOUT, checked: true }).props.accessibilityHint).toBe('A buyout closes the whole day to walk-ins in the forecast.');
  expect(within(card).getByText('A buyout closes the whole day to walk-ins in the forecast.')).toBeTruthy();
  await fireEvent.press(within(card).getByRole('radio', { name: ALONGSIDE }));
  await fireEvent.changeText(guests, '');
  // Once, on the field.
  expect(within(card).getAllByText(/Enter the guests/)).toHaveLength(1);
  expect(within(card).getByText('Enter the guests to accept it alongside regular service.')).toBeTruthy();
  expect(acceptOf(card).props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.changeText(guests, '35');
  expect(acceptOf(card).props.accessibilityState).toMatchObject({ disabled: false });
  await fireEvent.press(acceptOf(card));
  expect(await screen.findByText('Saved a note: Private event, 35 guests, Sat, Jul 11, 2026.')).toBeTruthy();
  expect(api.writes).toEqual([{ method: 'POST', path: accept, body: { effect: 'more_guests', expectedGuests: 35 } }]);
});

test('an org admin accepts a move with an empty body, and turns reading event titles off', async () => {
  const api = await renderSheet(meOf(ACCESS.admin), true);
  const move = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c5/accept';
  api.respond[move] = () => ({ suggestion: { id: '0000000000000000000000c5', status: 'accepted' }, note: null, rule: null });
  api.respond['/api/org/weekly-suggestions/calendar-titles'] = () => ({ calendarTitles: { on: false } });
  await screen.findByRole('heading', { name: MOVE_HEADING });
  await fireEvent.press(acceptOf(cardOf(MOVE_HEADING, /^Accept moves the note/)));
  expect(await screen.findByText('Moved the note to Sat, Jul 25, 2026.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Turn off reading event titles' }));
  expect(await screen.findByText('Reading event titles is off.')).toBeTruthy();
  expect(api.writes).toEqual([
    { method: 'POST', path: move, body: {} },
    { method: 'PATCH', path: '/api/org/weekly-suggestions/calendar-titles', body: { on: false } },
  ]);
});

test('a spotted event that changed: the notice names its days, never its title, and is announced', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const api = await renderSheet(meOf(ACCESS.admin), true);
  const accept = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c4/accept';
  api.respond[accept] = () => {
    api.panel = { ...(api.panel as object), suggestions: fixture.panel.suggestions.filter((each) => (each as { type: string }).type !== 'event') };
    return refusal(409, 'event_changed');
  };
  await screen.findByRole('heading', { name: EVENT_HEADING });
  const card = cardOf(EVENT_HEADING, /^Choose how this event runs/);
  await fireEvent.press(within(card).getByRole('radio', { name: BUYOUT }));
  await fireEvent.press(acceptOf(card));
  const words = 'The event on Sat, Jul 11, 2026 moved or is no longer on your calendar, so nothing was saved.';
  expect(await screen.findByText(words)).toBeTruthy();
  expect(announce).toHaveBeenCalledWith(words);
});
