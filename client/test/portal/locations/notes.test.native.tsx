jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions } from 'react-native';
import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import type { Note, NoteInput } from '../../../src/portal/locations/api';
import { addDays, localToday } from '../../../src/portal/locations/dates';
import { formatDate } from '../../../src/portal/format';
import type { MeResponse } from '../../../src/portal/schemas';
import {
  ACCESS, ADMIN_EMAIL, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake, noteOf, type LocationsFake } from './fakes';

// P14 Notes and C6, the note form, on native (spec 16.3, 12).

afterEach(async () => {
  await cleanup();
});

const TODAY = localToday();
const day = (offset: number): string => addDays(TODAY, offset);
const NOTES: Note[] = [
  noteOf('n3', { kind: 'other', startDate: day(-40), endDate: day(-35), effect: 'fewer_guests', detail: 'Road work.' }),
  noteOf('n1', { startDate: day(10), endDate: day(12), weekdays: [1] }),
  noteOf('n2', {
    kind: 'private_event', startDate: day(20), endDate: day(20), effect: 'more_guests', expectedGuests: 40, detail: 'A rehearsal dinner.',
    createdByEmail: 'manager@example.com', canEdit: false,
  }),
];
const PATH = '/api/org/locations/l1/notes';

function setup(me: MeResponse = meOf(ACCESS.member), notes: unknown = NOTES): { api: FakePortalApi; fake: LocationsFake } {
  const fake = locationsFake({ notes: { l1: notes } });
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
}

function saved(id: string, body: unknown): { note: Note } {
  return { note: noteOf(id, { ...(body as NoteInput), createdByEmail: EMAIL, createdAt: '2026-11-04T15:00:00.000Z' }) };
}

function pressed(name: string): unknown {
  return screen.getByRole('button', { name }).props.accessibilityState;
}

test('loading shows one line under the intro', async () => {
  const { api } = setup(meOf(ACCESS.member), deferred<unknown>().promise);
  await renderApp('/locations/l1/notes', api);
  expect(await screen.findByText('Loading notes')).toBeTruthy();
  // The tuning chat reads notes (api/src/handlers/notes.ts), so the intro doesn't say nothing does.
  expect(screen.getByText(/^Notes record what your sales can’t show.*Only the tuning chat reads them yet\.$/)).toBeTruthy();
  expect(screen.getByText('Talking to your model is planned.')).toBeTruthy();
});

test('empty: no notes yet, with Add a note', async () => {
  const { api } = setup(meOf(ACCESS.member), []);
  await renderApp('/locations/l1/notes', api);
  expect(await screen.findByText('No notes yet.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Add a note' }));
  expect(screen.getByRole('heading', { name: 'Add a note' })).toBeTruthy();
  expect(screen.queryByText('No notes yet.')).toBeNull();
});

test('coming up and past, each note in plain words; Edit and Delete only where the API allows', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/notes', api);
  const coming = await screen.findByLabelText('Notes coming up');
  const past = screen.getByLabelText('Past notes');
  expect(within(coming).getByText('Closure')).toBeTruthy();
  expect(within(coming).getByText(`${formatDate(day(10))} to ${formatDate(day(12))}`)).toBeTruthy();
  expect(within(coming).getByText('Mondays only')).toBeTruthy();
  expect(within(coming).getByText('Closed')).toBeTruthy();
  expect(within(coming).getByText('Private event')).toBeTruthy();
  expect(within(coming).getByText(formatDate(day(20)))).toBeTruthy();
  expect(within(coming).getByText('More guests than usual')).toBeTruthy();
  expect(within(coming).getByText('About 40 guests')).toBeTruthy();
  expect(within(coming).getByText('A rehearsal dinner.')).toBeTruthy();
  // The email sits on its own line, with the date under it, so it can use the column's whole width.
  expect(within(coming).getByText('manager@example.com')).toBeTruthy();
  expect(within(coming).getAllByText('Feb 1, 2026').length).toBeGreaterThan(0);
  expect(within(past).getByText('Other')).toBeTruthy();
  expect(within(past).getByText('Road work.')).toBeTruthy();
  expect(within(past).getByText('Fewer guests than usual')).toBeTruthy();
  expect(within(coming).getByRole('button', { name: `Edit Closure note, ${formatDate(day(10))} to ${formatDate(day(12))}` })).toBeTruthy();
  expect(within(coming).queryByRole('button', { name: `Edit Private event note, ${formatDate(day(20))}` })).toBeNull();
  expect(within(coming).queryByRole('button', { name: `Delete Private event note, ${formatDate(day(20))}` })).toBeNull();
});

test('the form checks the API’s rules before it sends, then saves the note, selects it and says Saved', async () => {
  const { api } = setup();
  api.answers[PATH] = (body) => saved('n9', body);
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Add a note' }));
  expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
  // Closure is the first kind; its effect is Closed, which hides Expected guests.
  expect(pressed('Closure')).toMatchObject({ checked: true });
  expect(pressed('Closed')).toMatchObject({ checked: true });
  expect(screen.queryByLabelText('Expected guests (optional)')).toBeNull();
  expect(screen.getByText('Describe the event, not the guests. Leave out names. Up to 280 characters.')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(screen.getByText('Enter the start date.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Starts'), day(5));
  await fireEvent.changeText(screen.getByLabelText('Ends (optional)'), day(3));
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(screen.getByText('The end date is before the start date.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Ends (optional)'), day(5 + 367));
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(screen.getByText('Pick a range of a year or less.')).toBeTruthy();

  // Other: Not sure, Expected guests shown, and Details required.
  await fireEvent.press(screen.getByRole('button', { name: 'Other' }));
  expect(pressed('Not sure')).toMatchObject({ checked: true });
  expect(screen.getByLabelText('Details')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Ends (optional)'), '');
  await fireEvent.changeText(screen.getByLabelText('Expected guests (optional)'), '0');
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(screen.getByText('Add details for an Other note.')).toBeTruthy();
  expect(screen.getByText('Enter a whole number from 1 to 20,000.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  // A private event defaults to More guests; the owner can change the effect.
  await fireEvent.press(screen.getByRole('button', { name: 'Private event' }));
  expect(pressed('More guests than usual')).toMatchObject({ checked: true });
  await fireEvent.press(screen.getByRole('button', { name: 'Fewer guests than usual' }));
  expect(pressed('Fewer guests than usual')).toMatchObject({ checked: true });
  await fireEvent.press(screen.getByRole('button', { name: 'More guests than usual' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Saturday' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Friday' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Sunday' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Sunday' }));
  expect(pressed('Friday')).toMatchObject({ checked: true });
  expect(pressed('Sunday')).toMatchObject({ checked: false });
  await fireEvent.changeText(screen.getByLabelText('Expected guests (optional)'), '1,200');
  await fireEvent.changeText(screen.getByLabelText('Details (optional)'), '  Alumni weekend dinner.  ');
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));

  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: PATH,
    body: { kind: 'private_event', startDate: day(5), endDate: day(5), weekdays: [5, 6], effect: 'more_guests', expectedGuests: 1200, detail: 'Alumni weekend dinner.' },
  }]);
  expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  const coming = screen.getByLabelText('Notes coming up');
  expect(within(coming).getByText('Alumni weekend dinner.')).toBeTruthy();
  expect(within(coming).getByText('Fridays and Saturdays only')).toBeTruthy();
  expect(within(coming).getByText('About 1,200 guests')).toBeTruthy();
});

test('Edit opens the note in the form and replaces it in full', async () => {
  const { api } = setup(meOf(ACCESS.admin));
  api.answers[`${PATH}/n1`] = (body) => saved('n1', body);
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: `Edit Closure note, ${formatDate(day(10))} to ${formatDate(day(12))}` }));
  expect(screen.getByRole('heading', { name: 'Edit this note' })).toBeTruthy();
  expect(screen.getByLabelText('Starts').props.value).toBe(day(10));
  expect(screen.getByLabelText('Ends (optional)').props.value).toBe(day(12));
  expect(pressed('Monday')).toMatchObject({ checked: true });
  await fireEvent.changeText(screen.getByLabelText('Details (optional)'), 'Closed for the off-season.');
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'PATCH', path: `${PATH}/n1`,
    body: { kind: 'closure', startDate: day(10), endDate: day(12), weekdays: [1], effect: 'closed', expectedGuests: null, detail: 'Closed for the off-season.' },
  }]);
  expect(screen.getByText('Closed for the off-season.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: `Edit Closure note, ${formatDate(day(10))} to ${formatDate(day(12))}` }));
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('heading', { name: 'Edit this note' })).toBeNull();
});

test('Delete asks first, then removes the note', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: `Delete Other note, ${formatDate(day(-40))} to ${formatDate(day(-35))}` }));
  expect(screen.getByRole('heading', { name: 'Delete this note?' })).toBeTruthy();
  expect(screen.getByText('This can’t be undone.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Delete note' }));
  expect(await screen.findByText('Deleted the note.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'DELETE', path: `${PATH}/n3`, body: undefined }]);
  expect(screen.queryByText('Road work.')).toBeNull();
  expect(screen.queryByLabelText('Past notes')).toBeNull();
});

test('save failures: the note limit, the network, and anything else', async () => {
  const { api } = setup();
  api.answers[PATH] = () => refusal(409, 'note_limit');
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Add a note' }));
  await fireEvent.changeText(screen.getByLabelText('Starts'), day(1));
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('This location has 1,000 notes. Delete old ones to add more.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  api.answers[PATH] = () => offline();
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  api.answers[PATH] = () => refusal(500, 'internal');
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Couldn’t save the note. Try again.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Add a note' })).toBeTruthy();
});

test('a delete that fails keeps the dialog open with the shared copy, and the note stays', async () => {
  const { api, fake } = setup();
  fake.deletes[`${PATH}/n3`] = () => offline();
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: `Delete Other note, ${formatDate(day(-40))} to ${formatDate(day(-35))}` }));
  await fireEvent.press(screen.getByRole('button', { name: 'Delete note' }));
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Delete this note?' })).toBeTruthy();
  expect(within(screen.getByLabelText('Past notes')).getByText('Road work.')).toBeTruthy();
});

test('an edit of a note deleted elsewhere closes the form, says the note isn’t available and reloads the list', async () => {
  const { api, fake } = setup(meOf(ACCESS.admin));
  api.answers[`${PATH}/n1`] = () => {
    fake.notes.l1 = NOTES.filter((note) => note.id !== 'n1');
    return refusal(404, 'not_found');
  };
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: `Edit Closure note, ${formatDate(day(10))} to ${formatDate(day(12))}` }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('This note isn’t available.')).toBeTruthy();
  expect(screen.queryByText('Couldn’t save the note. Try again.')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Edit this note' })).toBeNull();
  const coming = await screen.findByLabelText('Notes coming up');
  expect(within(coming).queryByText('Closure')).toBeNull();
  expect(within(coming).getByText('Private event')).toBeTruthy();
  expect(writes(api)).toHaveLength(1);
});

test('a delete of a note deleted elsewhere closes the dialog, says the note isn’t available and reloads the list', async () => {
  const { api, fake } = setup();
  fake.deletes[`${PATH}/n3`] = () => {
    fake.notes.l1 = NOTES.filter((note) => note.id !== 'n3');
    return refusal(404, 'not_found');
  };
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: `Delete Other note, ${formatDate(day(-40))} to ${formatDate(day(-35))}` }));
  await fireEvent.press(screen.getByRole('button', { name: 'Delete note' }));
  expect(await screen.findByText('This note isn’t available.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Delete this note?' })).toBeNull();
  expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
  expect(screen.queryByText('Deleted the note.')).toBeNull();
  expect(await screen.findByLabelText('Notes coming up')).toBeTruthy();
  expect(screen.queryByLabelText('Past notes')).toBeNull();
});

test('a new note for a location deleted elsewhere says the location isn’t available, with the way back', async () => {
  const { api, fake } = setup();
  api.answers[PATH] = () => {
    fake.notes.l1 = refusal(404, 'not_found');
    return refusal(404, 'not_found');
  };
  await renderApp('/locations/l1/notes', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Add a note' }));
  await fireEvent.changeText(screen.getByLabelText('Starts'), day(1));
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
  expect(screen.queryByText('This note isn’t available.')).toBeNull();
  expect(screen.queryByText('Couldn’t save the note. Try again.')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Add a note' })).toBeNull();
  expect(screen.getAllByRole('link', { name: 'Locations' }).length).toBeGreaterThan(0);
});

test('load errors: the shared copy with Try again; an unknown location is not available', async () => {
  const { api, fake } = setup(meOf(ACCESS.member), offline());
  await renderApp('/locations/l1/notes', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fake.notes.l1 = refusal(404, 'not_found');
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
});

test('view-as: Add, Edit and Delete are disabled in place with the read-only line, and the closure link opens nothing', async () => {
  const { api } = setup(viewAsMe(ACCESS.admin));
  await renderApp('/locations/l1/notes?new=closure', api);
  expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Add a note' })).toBeNull();
  const controls = [
    screen.getByRole('button', { name: 'Add a note' }),
    screen.getByRole('button', { name: `Edit Closure note, ${formatDate(day(10))} to ${formatDate(day(12))}` }),
    screen.getByRole('button', { name: `Delete Closure note, ${formatDate(day(10))} to ${formatDate(day(12))}` }),
  ];
  for (const control of controls) {
    expect(control.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(control);
  }
  await waitFor(() => { expect(screen.queryByRole('heading', { name: 'Delete this note?' })).toBeNull(); });
  expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('at 768px an email is one text of its own and Edit and Delete share one row', async () => {
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 768 });
  try {
    const { api } = setup();
    await renderApp('/locations/l1/notes', api);
    const coming = await screen.findByLabelText('Notes coming up');
    expect(within(coming).getByText(ADMIN_EMAIL)).toBeTruthy();
    const name = `${formatDate(day(10))} to ${formatDate(day(12))}`;
    const edit = within(coming).getByRole('button', { name: `Edit Closure note, ${name}` });
    const del = within(coming).getByRole('button', { name: `Delete Closure note, ${name}` });
    expect(edit.parent).toBe(del.parent);
  } finally {
    spy.mockRestore();
  }
});
