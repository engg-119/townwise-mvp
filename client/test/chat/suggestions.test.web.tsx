import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { decidedLine, suggestionFacts, suggestionHeading, TITLES_WORDS, weeklyWords } from '../../src/chat/ui/SuggestionCard';
import type { Suggestion } from '../../src/chat/api';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, noteOf, refusal, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, openAsAdminMe, orgOf } from '../helpers/portal';
import { serveAbout } from './about-fakes';

// TownwiseAI's weekly suggestions in P25's panel on web (openspec change weekly-forecast-suggestions): each card asks
// its question with TownwiseAI's why and the calendar entries it names; org admins get Accept and Dismiss and the
// switch's button, members see the cards and whether the switch is on, with neither; what a decision did stays on the
// card; a suggestion the server no longer has open reads the panel again. The fixture is the API's (agent-panel.json).
// The location's calendars (openspec change calendar-event-suggestions) add a spotted private event, whose card asks a
// buyout or alongside regular service with neither chosen and a guest count, and the follow-ups of a note whose event
// moved or went, in their own section, "Your calendar changed", before the suggestions; and the switch for reading the
// calendars' event titles beside the weekly one.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; suggestions: unknown[]; weeklySuggestions: Record<string, boolean> };
};

const NOTE_HEADING = 'Closed on Sat, Jul 4, 2026?';
const RULE_HEADING = 'Add the rule “Private party after Commencement”?';
const EVENT_HEADING = 'A private event on Sat, Jul 11, 2026?';
const MOVE_HEADING = 'Move the note to Sat, Jul 25, 2026?';
const REMOVE_HEADING = 'Delete the note on Sat, Aug 1, 2026?';
const BUYOUT = 'The whole restaurant (a buyout)';
const ALONGSIDE = 'Alongside regular service';
const EVENT_ACCEPT = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c4/accept';
const TITLES_PATH = '/api/org/weekly-suggestions/calendar-titles';
const SWITCH_WORDS = weeklyWords('Hanover');

// The composer measures itself; jsdom has no ResizeObserver, and nothing here lays anything out.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void { /* nothing is laid out */ }
    unobserve(): void { /* nothing is laid out */ }
    disconnect(): void { /* nothing is laid out */ }
  };
}

Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1280 });

afterEach(() => {
  cleanup();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
});

function chatApi(canChange: boolean): FakeChatApi {
  const api = fakeChatApi();
  api.panel = { ...fixture.panel, weeklySuggestions: { ...fixture.panel.weeklySuggestions, available: true, canChange } };
  return api;
}

function renderAt(api: FakeChatApi, me: MeResponse): void {
  serveAbout(api);
  const role = me.access.state === 'member' ? me.access.role : 'member';
  const portal = fakePortalApi({ me, org: orgOf(role), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: ['a', 'example.com'].join('@') } }, { api: portal });
  const path = '/locations/l1/agent?panel=questions';
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext(appRoutes(seededRoot(auth), {
          '(marketing)/index': () => null, '(gate)/sign-in': () => null, '(gate)/totp': () => null, '(gate)/auth/magic': () => null,
        }))}
        location={path}
      />
    </Head.Provider>,
  );
}

async function side(): Promise<HTMLElement> {
  const found = await screen.findByTestId('agent-side');
  await within(found).findByRole('heading', { name: 'Suggested for the next 3 months' });
  return found;
}

function card(scope: HTMLElement, heading: string): HTMLElement {
  const found = within(scope).getByRole('heading', { level: 3, name: heading }).parentElement;
  if (found === null) throw new Error(`no card for ${heading}`);
  return found;
}

/** A section of the panel, by its heading: the heading's head, then the section around it. */
function section(scope: HTMLElement, heading: string): HTMLElement {
  const found = within(scope).getByRole('heading', { level: 2, name: heading }).parentElement?.parentElement;
  if (found === null || found === undefined) throw new Error(`no section ${heading}`);
  return found;
}

const SUGGESTED = 'Suggested for the next 3 months';
const CHANGED = 'Your calendar changed';

test('members see each suggestion with its why and calendar entries, and whether the switch is on, with no buttons', async () => {
  renderAt(chatApi(false), meOf(ACCESS.member));
  const panel = await side();
  // The rule, the note and the spotted event; the move and the removal count in their own section, and the suggested
  // rules above them (D46) have theirs.
  expect(within(section(panel, SUGGESTED)).getByText('3 to decide')).toBeTruthy();
  expect(within(section(panel, CHANGED)).getByText('2 to decide')).toBeTruthy();
  const note = card(panel, NOTE_HEADING);
  expect(within(note).getByText('Independence Day is Sat, Jul 4, and you were closed on it last year.')).toBeTruthy();
  expect(within(note).getByText('Based on Independence Day (Sat, Jul 4, 2026).')).toBeTruthy();
  expect(within(note).getByText('An admin of your organization can accept or dismiss this.')).toBeTruthy();
  // A closure's heading already says all it saves: no line repeats "Closed".
  expect(within(note).queryByText(/^Closed\./)).toBeNull();
  const rule = card(panel, RULE_HEADING);
  expect(within(rule).getByText('Adds 40 guests on Jun 14, 2026, 6 pm to 10 pm')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Accept' })).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Dismiss' })).toBeNull();
  expect(within(panel).getByText('Weekly suggestions are on.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Turn off weekly suggestions' })).toBeNull();
  expect(within(panel).getByText(SWITCH_WORDS, { exact: false })).toBeTruthy();
  expect(within(panel).getAllByRole('link', { name: 'Privacy' })[0]?.getAttribute('href')).toBe('/privacy');
});

test('an org admin accepts a note and dismisses a rule; each card then says what it did', async () => {
  const api = chatApi(true);
  const acceptPath = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c1/accept';
  const dismissPath = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c2/dismiss';
  api.respond[acceptPath] = () => ({ suggestion: { id: '0000000000000000000000c1', status: 'accepted' }, note: null, rule: null });
  api.respond[dismissPath] = () => ({ suggestion: { id: '0000000000000000000000c2', status: 'dismissed' }, note: null, rule: null });
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const note = card(panel, NOTE_HEADING);
  expect(within(note).getByText(/^Accept saves this note/)).toBeTruthy();
  fireEvent.click(within(note).getByRole('button', { name: 'Accept' }));
  expect(await within(note).findByText('Saved a note: Closure, Sat, Jul 4, 2026.')).toBeTruthy();
  const rule = card(panel, RULE_HEADING);
  fireEvent.click(within(rule).getByRole('button', { name: 'Dismiss' }));
  expect(await within(rule).findByText('Dismissed. TownwiseAI won’t suggest it again.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path.includes('/suggestions/'))).toEqual([
    { method: 'POST', path: acceptPath, body: {} }, { method: 'POST', path: dismissPath, body: {} },
  ]);
  // The spotted event is left to decide.
  expect(within(section(panel, SUGGESTED)).getByText('1 to decide')).toBeTruthy();
  // The switch still answers after a decision.
  api.respond['/api/org/weekly-suggestions'] = () => ({ weeklySuggestions: { on: false } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off weekly suggestions' }));
  expect(await within(panel).findByText('Weekly suggestions are off.')).toBeTruthy();
});

test('after Accept or Dismiss, focus moves to the line that says what it did (the buttons are gone)', async () => {
  const api = chatApi(true);
  api.respond['/api/org/locations/l1/agent/suggestions/0000000000000000000000c1/accept'] = () => (
    { suggestion: { id: '0000000000000000000000c1', status: 'accepted' }, note: null, rule: null }
  );
  api.respond['/api/org/locations/l1/agent/suggestions/0000000000000000000000c2/dismiss'] = () => (
    { suggestion: { id: '0000000000000000000000c2', status: 'dismissed' }, note: null, rule: null }
  );
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const accept = within(card(panel, NOTE_HEADING)).getByRole('button', { name: 'Accept' });
  accept.focus();
  fireEvent.click(accept);
  const saved = await within(card(panel, NOTE_HEADING)).findByText('Saved a note: Closure, Sat, Jul 4, 2026.');
  await waitFor(() => { expect(saved.closest('[role="status"]')?.contains(document.activeElement)).toBe(true); });
  const dismiss = within(card(panel, RULE_HEADING)).getByRole('button', { name: 'Dismiss' });
  dismiss.focus();
  fireEvent.click(dismiss);
  const dismissed = await within(card(panel, RULE_HEADING)).findByText('Dismissed. TownwiseAI won’t suggest it again.');
  await waitFor(() => { expect(dismissed.closest('[role="status"]')?.contains(document.activeElement)).toBe(true); });
});

test('an org admin turns weekly suggestions off and back on', async () => {
  const api = chatApi(true);
  api.respond['/api/org/weekly-suggestions'] = (body) => ({ weeklySuggestions: { on: (body as { on: boolean }).on } });
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off weekly suggestions' }));
  expect(await within(panel).findByText('Weekly suggestions are off.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn on weekly suggestions' }));
  expect(await within(panel).findByText('Weekly suggestions are on.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path === '/api/org/weekly-suggestions').map((write) => write.body)).toEqual([{ on: false }, { on: true }]);
});

test('a suggestion the server no longer has open reads the panel again; another refusal stays on its card', async () => {
  const api = chatApi(true);
  const acceptPath = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c1/accept';
  api.respond[acceptPath] = () => refusal(409, 'note_limit');
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  fireEvent.click(within(card(panel, NOTE_HEADING)).getByRole('button', { name: 'Accept' }));
  expect(await within(card(panel, NOTE_HEADING)).findByText('This location has 1,000 notes. Delete old ones to add more.')).toBeTruthy();
  const loads = api.panelLoads;
  api.respond[acceptPath] = () => refusal(404, 'not_found');
  fireEvent.click(within(card(panel, NOTE_HEADING)).getByRole('button', { name: 'Accept' }));
  await waitFor(() => { expect(api.panelLoads).toBeGreaterThan(loads); });
});

/** An open note suggestion of kind other, with its effect, guests, hours and detail (synthetic). */
const OTHER_NOTE = {
  id: '0000000000000000000000c3', why: 'Winter term starts Fri, Jan 8, and your January weeks rose with it last year.', calendar: [],
  createdAt: '2026-11-16T06:00:00.000Z', type: 'note',
  note: {
    kind: 'other', startDate: '2027-01-08', endDate: '2027-01-10', weekdays: null, effect: 'more_guests', expectedGuests: 220,
    startTime: '18:00', endTime: '21:00', detail: 'Winter term starts; students back in town',
  },
};

test('a note suggestion shows what Accept will save: its effect in the heading, its guests and hours, and its detail as written', async () => {
  const api = chatApi(true);
  api.panel = { ...(api.panel as object), suggestions: [OTHER_NOTE] };
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const note = card(panel, 'More guests than usual on Jan 8 to Jan 10, 2027?');
  expect(within(note).getByText('About 220 guests. 6 pm to 9 pm.')).toBeTruthy();
  expect(within(note).getByText('Winter term starts; students back in town')).toBeTruthy();
});

test('a note suggestion with an event name shows it (D49)', async () => {
  const api = chatApi(true);
  api.panel = { ...(api.panel as object), suggestions: [{ ...OTHER_NOTE, note: { ...OTHER_NOTE.note, title: 'Winter term welcome' } }] };
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const note = card(panel, 'More guests than usual on Jan 8 to Jan 10, 2027?');
  expect(within(note).getByText('Event name: Winter term welcome')).toBeTruthy();
});

test('a note of kind other asks its effect, never "Other", in its heading and in what Accept saved', () => {
  const other = (effect: string): Suggestion => ({ ...OTHER_NOTE, note: { ...OTHER_NOTE.note, effect, startDate: '2026-12-31', endDate: '2026-12-31' } }) as Suggestion;
  expect(suggestionHeading(other('more_guests'))).toBe('More guests than usual on Thu, Dec 31, 2026?');
  expect(suggestionHeading(other('fewer_guests'))).toBe('Fewer guests than usual on Thu, Dec 31, 2026?');
  expect(suggestionHeading(other('unknown'))).toBe('Something unusual on Thu, Dec 31, 2026?');
  expect(suggestionHeading(other('closed'))).toBe('Closed on Thu, Dec 31, 2026?');
  expect(decidedLine(other('more_guests'), { status: 'accepted', note: null, rule: null })).toBe('Saved a note: More guests than usual, Thu, Dec 31, 2026.');
  expect(decidedLine(other('unknown'), { status: 'accepted', note: null, rule: null })).toBe('Saved a note: Something unusual, Thu, Dec 31, 2026.');
  // The heading says the effect, so the facts don't repeat it.
  expect(suggestionFacts(other('unknown'))).toBe('About 220 guests. 6 pm to 9 pm.');
});

test('with none open, the section says so and still shows the switch', async () => {
  const api = chatApi(false);
  api.panel = { ...(api.panel as object), suggestions: [] };
  renderAt(api, meOf(ACCESS.member));
  const panel = await side();
  expect(within(panel).getByText('No suggestions right now.')).toBeTruthy();
  expect(within(panel).getByText('Weekly suggestions are on.')).toBeTruthy();
});

test('the header’s Questions and activity button counts open questions and open suggestions, as Home’s link does', async () => {
  // The fixture asks 2 questions and has 5 weekly suggestions open (a rule, a note, a spotted event, a move and a
  // removal) and (D46) 2 suggested rules: Home's link reads "9 questions from TownwiseAI".
  const api = chatApi(true);
  api.respond['/api/org/locations/l1/agent/suggestions/0000000000000000000000c2/dismiss'] = () => (
    { suggestion: { id: '0000000000000000000000c2', status: 'dismissed' }, note: null, rule: null }
  );
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  expect(screen.getByRole('button', { name: 'Questions and activity (9)' })).toBeTruthy();
  fireEvent.click(within(card(panel, RULE_HEADING)).getByRole('button', { name: 'Dismiss' }));
  expect(await screen.findByRole('button', { name: 'Questions and activity (8)' })).toBeTruthy();
});

test('while weekly passes aren’t running, the panel says only that, never that TownwiseAI is unavailable', async () => {
  const api = chatApi(false);
  api.panel = { ...(api.panel as object), weeklySuggestions: { on: true, available: false, canChange: false } };
  renderAt(api, meOf(ACCESS.member));
  const panel = await side();
  expect(within(panel).getByText('Weekly suggestions aren’t running right now, so none are being made.')).toBeTruthy();
  expect(within(panel).queryByText(/isn’t available here/)).toBeNull();
});

function decided(id: string, status = 'accepted'): () => unknown {
  return () => ({ suggestion: { id, status }, note: null, rule: null });
}

/** A spotted event's accept, answered with the private-event note it saved (the API's shape). */
function savedEvent(id: string, effect: 'closed' | 'more_guests', expectedGuests: number | null): () => unknown {
  return () => ({
    suggestion: { id, status: 'accepted' },
    note: noteOf({ kind: 'private_event', startDate: '2026-07-11', endDate: '2026-07-11', effect, expectedGuests, startTime: '18:00', endTime: '22:00', detail: null }, 'n9'),
    rule: null,
  });
}

/** The words of the elements an element is described by. */
function describedWords(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

const EVENT_DISMISS = 'Dismiss and TownwiseAI won’t ask about this event again.';
const BUYOUT_EFFECT = 'A buyout closes the whole day to walk-ins in the forecast.';
const ALONGSIDE_EFFECT = 'These guests add to the whole day’s total.';

test('“Your calendar changed” comes before the suggestions, with the move and the removal in the server’s words; the spotted event is a suggestion', async () => {
  renderAt(chatApi(false), meOf(ACCESS.member));
  const panel = await side();
  // The fixture's suggested rules (D46) come first, in their own section.
  expect(within(panel).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent).slice(0, 3))
    .toEqual(['Suggested rules', CHANGED, SUGGESTED]);
  const changed = section(panel, CHANGED);
  expect(within(changed).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([MOVE_HEADING, REMOVE_HEADING]);
  expect(within(card(changed, MOVE_HEADING)).getByText('The private event on Sat, Jul 18 moved to Sat, Jul 25 on your calendar.')).toBeTruthy();
  expect(within(card(changed, MOVE_HEADING)).getByText('About 60 guests. 6 pm to 10 pm.')).toBeTruthy();
  expect(within(card(changed, REMOVE_HEADING)).getByText('The private event on Sat, Aug 1 is no longer on your calendar.')).toBeTruthy();
  const suggested = section(panel, SUGGESTED);
  expect(within(suggested).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([RULE_HEADING, NOTE_HEADING, EVENT_HEADING]);
  const spotted = card(suggested, EVENT_HEADING);
  expect(within(spotted).getByText('From your calendar: Private party, 40 guests, Sat, Jul 11, 6 pm to 10 pm')).toBeTruthy();
  // Members see no choice, count, Accept or Dismiss.
  expect(within(panel).queryByRole('radiogroup')).toBeNull();
  expect(within(panel).queryByLabelText('Guests')).toBeNull();
  expect(within(spotted).getByText('An admin of your organization can accept or dismiss this.')).toBeTruthy();
});

test('a spotted event offers two choices with neither chosen; Accept stays disabled, saying why, until one is chosen', async () => {
  const api = chatApi(true);
  api.respond[EVENT_ACCEPT] = savedEvent('0000000000000000000000c4', 'closed', 40);
  renderAt(api, meOf(ACCESS.admin));
  const spotted = card(await side(), EVENT_HEADING);
  const group = within(spotted).getByRole('radiogroup', { name: 'How this event runs' });
  const radios = within(group).getAllByRole('radio');
  expect(radios.map((radio) => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([[BUYOUT, 'false'], [ALONGSIDE, 'false']]);
  // One tab stop: the first choice while none is chosen.
  expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1']);
  const guests = within(spotted).getByLabelText<HTMLInputElement>('Guests');
  expect(guests.value).toBe('40');
  const accept = within(spotted).getByRole('button', { name: 'Accept' });
  expect(accept.getAttribute('aria-disabled')).toBe('true');
  // The reason, then what Dismiss does.
  const why = within(spotted).getByText(`Choose how this event runs to accept it. ${EVENT_DISMISS}`);
  expect(accept.getAttribute('aria-describedby')?.split(' ')).toContain(why.id);
  // No line on the forecast until a choice is made.
  expect(within(spotted).queryByText(BUYOUT_EFFECT)).toBeNull();
  expect(group.getAttribute('aria-describedby')).toBeNull();
  fireEvent.click(within(group).getByRole('radio', { name: BUYOUT }));
  expect(within(group).getByRole('radio', { name: BUYOUT }).getAttribute('aria-checked')).toBe('true');
  expect(accept.getAttribute('aria-disabled')).toBeNull();
  // The choice says what it does to the forecast, and the group is described by it.
  expect(within(spotted).getByText(BUYOUT_EFFECT)).toBeTruthy();
  expect(describedWords(group)).toBe(BUYOUT_EFFECT);
  accept.focus();
  fireEvent.click(accept);
  // Built from the note the accept saved: a buyout, with its party.
  const saved = await within(spotted).findByText('Saved a note: Private buyout, 40 guests, Sat, Jul 11, 2026.');
  await waitFor(() => { expect(saved.closest('[role="status"]')?.contains(document.activeElement)).toBe(true); });
  expect(api.writes.filter((write) => write.path.includes('/suggestions/'))).toEqual([
    { method: 'POST', path: EVENT_ACCEPT, body: { effect: 'closed', expectedGuests: 40 } },
  ]);
});

test('alongside regular service needs a count, a buyout none; the arrow keys move the choice; a bad count says so once, on the field', async () => {
  const api = chatApi(true);
  api.respond[EVENT_ACCEPT] = savedEvent('0000000000000000000000c4', 'more_guests', 25);
  renderAt(api, meOf(ACCESS.admin));
  const spotted = card(await side(), EVENT_HEADING);
  const group = within(spotted).getByRole('radiogroup', { name: 'How this event runs' });
  const accept = within(spotted).getByRole('button', { name: 'Accept' });
  const guests = within(spotted).getByLabelText<HTMLInputElement>('Guests');
  fireEvent.change(guests, { target: { value: '' } });
  fireEvent.click(within(group).getByRole('radio', { name: BUYOUT }));
  expect(accept.getAttribute('aria-disabled')).toBeNull();
  fireEvent.keyDown(within(group).getByRole('radio', { name: BUYOUT }), { key: 'ArrowRight' });
  expect(within(group).getByRole('radio', { name: ALONGSIDE }).getAttribute('aria-checked')).toBe('true');
  expect(within(group).getByRole('radio', { name: BUYOUT }).getAttribute('aria-checked')).toBe('false');
  expect(accept.getAttribute('aria-disabled')).toBe('true');
  expect(within(spotted).getByText(ALONGSIDE_EFFECT)).toBeTruthy();
  expect(describedWords(group)).toBe(ALONGSIDE_EFFECT);
  // The empty field itself needs a value: its message, tied to it, once; the help line says what Accept and Dismiss do.
  expect(within(spotted).getAllByText(/Enter the guests/)).toHaveLength(1);
  expect(guests.getAttribute('aria-invalid')).toBe('true');
  expect(describedWords(guests)).toContain('Enter the guests to accept it alongside regular service.');
  expect(within(spotted).getByText(/^Accept saves a private-event note for these days/).textContent).toContain(EVENT_DISMISS);
  fireEvent.change(guests, { target: { value: 'forty' } });
  expect(within(spotted).getAllByText(/whole number from 1 to 20,000/)).toHaveLength(1);
  expect(describedWords(guests)).toContain('Enter a whole number from 1 to 20,000.');
  expect(guests.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(guests, { target: { value: '25' } });
  expect(accept.getAttribute('aria-disabled')).toBeNull();
  expect(guests.getAttribute('aria-invalid')).toBeNull();
  fireEvent.click(accept);
  expect(await within(spotted).findByText('Saved a note: Private event, 25 guests, Sat, Jul 11, 2026.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path.includes('/suggestions/')).map((write) => write.body)).toEqual([
    { effect: 'more_guests', expectedGuests: 25 },
  ]);
});

test('an org admin accepts the move and the removal with an empty body, and dismisses a follow-up', async () => {
  const api = chatApi(true);
  const move = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c5/accept';
  const remove = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c6/accept';
  api.respond[move] = decided('0000000000000000000000c5');
  api.respond[remove] = decided('0000000000000000000000c6');
  renderAt(api, meOf(ACCESS.admin));
  const changed = section(await side(), CHANGED);
  expect(within(card(changed, MOVE_HEADING)).getByText(/^Accept moves the note to the event’s new dates/)).toBeTruthy();
  fireEvent.click(within(card(changed, MOVE_HEADING)).getByRole('button', { name: 'Accept' }));
  expect(await within(card(changed, MOVE_HEADING)).findByText('Moved the note to Sat, Jul 25, 2026.')).toBeTruthy();
  fireEvent.click(within(card(changed, REMOVE_HEADING)).getByRole('button', { name: 'Accept' }));
  expect(await within(card(changed, REMOVE_HEADING)).findByText('Deleted the note.')).toBeTruthy();
  expect(within(changed).getByText('0 to decide')).toBeTruthy();
  expect(api.writes.filter((write) => write.path.includes('/suggestions/'))).toEqual([
    { method: 'POST', path: move, body: {} }, { method: 'POST', path: remove, body: {} },
  ]);
  expect(decidedLine(fixture.panel.suggestions[3] as Suggestion, { status: 'dismissed', note: null, rule: null })).toBe('Dismissed. The note stays as it is.');
});

test('a note changed since its follow-up: the card says so and the panel reads again; a spotted event that changed goes, and the notice takes focus', async () => {
  const api = chatApi(true);
  const move = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c5/accept';
  api.respond[move] = () => refusal(409, 'note_changed');
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const loads = api.panelLoads;
  fireEvent.click(within(card(panel, MOVE_HEADING)).getByRole('button', { name: 'Accept' }));
  await waitFor(() => { expect(api.panelLoads).toBeGreaterThan(loads); });
  // Dismiss stays the way out: the Accept would fail again until the calendar next refreshes.
  expect(await within(card(panel, MOVE_HEADING)).findByText(
    'Someone changed this note since, so nothing was changed. Check the note, or wait for your calendar’s next refresh. Dismiss keeps the note as it is.',
  )).toBeTruthy();
  // The spotted event moved at its source: its card goes when the panel reads again without it.
  api.respond[EVENT_ACCEPT] = () => {
    api.panel = { ...(api.panel as { suggestions: unknown[] }), suggestions: fixture.panel.suggestions.filter((each) => (each as { type: string }).type !== 'event') };
    return refusal(409, 'event_changed');
  };
  fireEvent.click(within(card(panel, EVENT_HEADING)).getByRole('radio', { name: BUYOUT }));
  fireEvent.click(within(card(panel, EVENT_HEADING)).getByRole('button', { name: 'Accept' }));
  // The notice names the event by its days as the card showed them, never by its title.
  const notice = await within(panel).findByText('The event on Sat, Jul 11, 2026 moved or is no longer on your calendar, so nothing was saved.');
  await waitFor(() => { expect(within(panel).queryByRole('heading', { name: EVENT_HEADING })).toBeNull(); });
  await waitFor(() => { expect(notice.closest('[role="status"]')?.contains(document.activeElement)).toBe(true); });
});

test('a panel read after one card’s 409 keeps the choice and guests on the other spotted events', async () => {
  const api = chatApi(true);
  // A second spotted event, a day later.
  const first = fixture.panel.suggestions[2] as { note: Record<string, unknown> };
  const withBoth = [...fixture.panel.suggestions, { ...first, id: '0000000000000000000000c7', note: { ...first.note, startDate: '2026-07-12', endDate: '2026-07-12' } }];
  api.panel = { ...(api.panel as object), suggestions: withBoth };
  api.respond[EVENT_ACCEPT] = () => {
    api.panel = { ...(api.panel as object), suggestions: withBoth.filter((each) => (each as { id: string }).id !== '0000000000000000000000c4') };
    return refusal(409, 'event_changed');
  };
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  const SECOND = 'A private event on Sun, Jul 12, 2026?';
  fireEvent.click(within(card(panel, SECOND)).getByRole('radio', { name: ALONGSIDE }));
  fireEvent.change(within(card(panel, SECOND)).getByLabelText('Guests'), { target: { value: '55' } });
  fireEvent.click(within(card(panel, EVENT_HEADING)).getByRole('radio', { name: BUYOUT }));
  const loads = api.panelLoads;
  fireEvent.click(within(card(panel, EVENT_HEADING)).getByRole('button', { name: 'Accept' }));
  await within(panel).findByText('The event on Sat, Jul 11, 2026 moved or is no longer on your calendar, so nothing was saved.');
  await waitFor(() => { expect(api.panelLoads).toBeGreaterThan(loads); });
  await waitFor(() => { expect(within(panel).queryByRole('heading', { name: EVENT_HEADING })).toBeNull(); });
  const kept = card(panel, SECOND);
  expect(within(kept).getByRole('radio', { name: ALONGSIDE }).getAttribute('aria-checked')).toBe('true');
  expect(within(kept).getByLabelText<HTMLInputElement>('Guests').value).toBe('55');
  expect(within(kept).getByText(ALONGSIDE_EFFECT)).toBeTruthy();
});

test('the titles switch: members see whether it is on; an org admin turns it off and on', async () => {
  renderAt(chatApi(false), meOf(ACCESS.member));
  let panel = await side();
  expect(within(panel).getByText(TITLES_WORDS, { exact: false })).toBeTruthy();
  expect(TITLES_WORDS).toContain('Once a week TownwiseAI also reads the titles, dates and hours of the next 3 months of events');
  // The weekly switch beside it says the same "Once a week".
  expect(SWITCH_WORDS.startsWith('Once a week TownwiseAI reads the next 3 months of Hanover’s calendar with your notes and rules')).toBe(true);
  expect(within(panel).getByText('Reading event titles is on.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Turn off reading event titles' })).toBeNull();
  cleanup();

  const api = chatApi(true);
  api.respond[TITLES_PATH] = (body) => ({ calendarTitles: { on: (body as { on: boolean }).on } });
  renderAt(api, meOf(ACCESS.admin));
  panel = await side();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off reading event titles' }));
  expect(await within(panel).findByText('Reading event titles is off.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn on reading event titles' }));
  expect(await within(panel).findByText('Reading event titles is on.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path === TITLES_PATH).map((write) => write.body)).toEqual([{ on: false }, { on: true }]);
});

test('staff open as admin can turn titles off, with the tab’s orgId, but never on, and the panel says so', async () => {
  const api = chatApi(true);
  api.respond[TITLES_PATH] = (body) => ({ calendarTitles: { on: (body as { on: boolean }).on } });
  renderAt(api, openAsAdminMe());
  const panel = await side();
  expect(within(panel).getByText('You can turn this off. Only an admin of this organization can turn it back on.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Turn off reading event titles' }));
  expect(await within(panel).findByText('Reading event titles is off.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Turn on reading event titles' })).toBeNull();
  expect(within(panel).getByText('Only an admin of this organization can turn this on.')).toBeTruthy();
  expect(api.writes.filter((write) => write.path === TITLES_PATH).map((write) => write.body)).toEqual([{ on: false, orgId: 'o1' }]);
});

test('an API from before calendar titles shows no titles switch', async () => {
  const api = chatApi(true);
  api.panel = { ...(api.panel as object), weeklySuggestions: { on: true, available: true, canChange: true } };
  renderAt(api, meOf(ACCESS.admin));
  const panel = await side();
  expect(within(panel).getByText('Weekly suggestions are on.')).toBeTruthy();
  expect(within(panel).queryByText(/event titles is/)).toBeNull();
});
