jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import type { LocationSummary } from '../../../src/portal/schemas';
import {
  ACCESS, deferred, fakePortalApi, LOCATIONS, locationOf, meOf, openAsAdminMe, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { DELETE_COPY, deleteBody } from '../../../src/portal/locations/LocationSettings';
import { locationsFake, salesOf, type LocationsFake } from './fakes';

// P16 Location settings and P10 Add location on native (spec 16.3).

afterEach(async () => {
  await cleanup();
});

function only(id: string): LocationSummary {
  const found = LOCATIONS.find((location) => location.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function setup(me = meOf(ACCESS.admin)): { api: FakePortalApi; fake: LocationsFake } {
  const fake = locationsFake({ sales: { l1: salesOf([]), l2: salesOf([]) } });
  return { api: fakePortalApi({ me, org: orgOf('org_admin'), fallback: fake }), fake };
}

function dialogButton(name: string): ReturnType<typeof screen.getByRole> {
  const button = screen.getAllByRole('button', { name }).at(-1);
  if (button === undefined) throw new Error(`no ${name}`);
  return button;
}

describe('P16 Location settings', () => {
  test('Name and Town are filled in; Save changes sends both, reloads the header and says Saved', async () => {
    const { api } = setup();
    const renamed = { ...only('l1'), name: 'Main Street Tavern', town: { townId: null, name: 'Norwich', state: 'VT' } };
    api.answers['/api/org/locations/l1'] = () => {
      api.org = orgOf('org_admin', [renamed, only('l2')]);
      return { location: renamed };
    };
    const { router } = await renderApp('/locations/l1/settings', api);
    expect(await screen.findByRole('heading', { name: 'Name and town' })).toBeTruthy();
    expect(screen.getByLabelText('Name').props.value).toBe('Main Street Bar');
    expect(screen.getByLabelText('Town').props.accessibilityValue).toEqual({ text: 'Hanover, NH' });
    await fireEvent.changeText(screen.getByLabelText('Name'), '  Main Street Tavern ');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Another town' }));
    await fireEvent.changeText(screen.getByLabelText('Town name'), 'Norwich');
    await fireEvent.press(screen.getByLabelText('State'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Vermont' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(writes(api)).toEqual([{
      method: 'PATCH', path: '/api/org/locations/l1', body: { name: 'Main Street Tavern', town: { townId: null, name: 'Norwich', state: 'VT' } },
    }]);
    expect(screen.getByText('Main Street Tavern, Norwich, VT')).toBeTruthy();
    expect(router.getPathname()).toBe('/locations/l1/settings');
  });

  test('while the organization reloads after Save, the Settings tab stays mounted on its own address', async () => {
    const { api } = setup();
    const renamed = { ...only('l1'), name: 'Main Street Tavern' };
    api.answers['/api/org/locations/l1'] = () => {
      api.org = orgOf('org_admin', [renamed, only('l2')]);
      return { location: renamed };
    };
    const { router } = await renderApp('/locations/l1/settings', api);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Main Street Tavern');
    // GET /api/org is held, as over a slow network, while the reload runs.
    const gate = deferred<null>();
    const json = api.json.bind(api);
    api.json = (path, schema, opts) => (path === '/api/org' ? gate.promise.then(() => json(path, schema, opts)) : json(path, schema, opts));
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(writes(api)).toHaveLength(1); });
    // The page is still there, with what was typed, not swapped for the loading line.
    expect(screen.queryByText('Loading this location')).toBeNull();
    expect(screen.getByLabelText('Name').props.value).toBe('Main Street Tavern');
    expect(router.getPathname()).toBe('/locations/l1/settings');
    api.json = json;
    await act(async () => { gate.resolve(null); await gate.promise; });
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.getByLabelText('Name').props.value).toBe('Main Street Tavern');
    expect(router.getPathname()).toBe('/locations/l1/settings');
  });

  test('field messages: an empty name stops the form; a taken name says so', async () => {
    const { api } = setup();
    api.answers['/api/org/locations/l1'] = () => refusal(409, 'location_name_taken');
    await renderApp('/locations/l1/settings', api);
    await fireEvent.changeText(await screen.findByLabelText('Name'), ' ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Enter the location’s name.')).toBeTruthy();
    expect(writes(api)).toEqual([]);
    await fireEvent.changeText(screen.getByLabelText('Name'), 'River Grill');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Another location already uses that name.')).toBeTruthy();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  test('a save after another admin deleted the location says it isn’t available, with the way back', async () => {
    const { api } = setup();
    api.answers['/api/org/locations/l1'] = () => {
      api.org = orgOf('org_admin', [only('l2')]);
      return refusal(404, 'not_found');
    };
    const { router } = await renderApp('/locations/l1/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
    expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    const back = screen.getAllByRole('link', { name: 'Locations' }).at(-1);
    if (back === undefined) throw new Error('no link');
    await fireEvent.press(back);
    // One location is left, so Locations opens its Forecast tab.
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l2'); });
  });

  test('a delete after another admin deleted the location closes the dialog and says it isn’t available', async () => {
    const { api, fake } = setup();
    fake.deletes['/api/org/locations/l2'] = () => {
      api.org = orgOf('org_admin', [only('l1')]);
      return refusal(404, 'not_found');
    };
    await renderApp('/locations/l2/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete location' }));
    await fireEvent.changeText(screen.getByLabelText('Type River Grill to confirm.'), 'River Grill');
    await fireEvent.press(dialogButton('Delete location'));
    // Not Locations with “Deleted River Grill.”, which would open the remaining location's Forecast tab.
    expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Delete River Grill?' })).toBeNull();
    expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
    expect(screen.queryByText('Deleted River Grill.')).toBeNull();
  });


  // D43: one press deletes the location with all its data; the dialog counts what goes.
  test('a location with sales and notes deletes in one press, and the dialog counts what goes with it', async () => {
    const { api, fake } = setup();
    fake.deletes['/api/org/locations/l1'] = () => {
      api.org = orgOf('org_admin', [only('l2')]);
      return null;
    };
    const { router } = await renderApp('/locations/l1/settings', api);
    expect(await screen.findByText('Can’t be undone')).toBeTruthy();
    expect(screen.getByText(DELETE_COPY.line)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete location' }));
    expect(screen.getByText('This deletes the location from Test Group with everything in it: 400 days of sales data, 2 notes, '
      + 'its stored files, business rules, ordering setup, calendars and TownwiseAI chats. This can’t be undone.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Type Main Street Bar to confirm.'), 'Main Street Bar');
    await fireEvent.press(dialogButton('Delete location'));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l2'); });
    expect(await screen.findByText('Deleted Main Street Bar.')).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'DELETE', path: '/api/org/locations/l1', body: undefined }]);
  });

  test('an empty location deletes behind its typed name, then Locations says so', async () => {
    const { api, fake } = setup();
    fake.deletes['/api/org/locations/l2'] = () => {
      api.org = orgOf('org_admin', [only('l1')]);
      return null;
    };
    const { router } = await renderApp('/locations/l2/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete location' }));
    expect(screen.getByRole('heading', { name: 'Delete River Grill?' })).toBeTruthy();
    expect(screen.getByText('This deletes the location from Test Group with everything in it: its stored files, business rules, '
      + 'ordering setup, calendars and TownwiseAI chats. This can’t be undone.')).toBeTruthy();
    expect(dialogButton('Delete location').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText('Type River Grill to confirm.'), 'River Grill');
    await fireEvent.press(dialogButton('Delete location'));
    // One location is left, so Locations opens its Forecast tab, which shows the notice.
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1'); });
    expect(await screen.findByText('Deleted River Grill.')).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'DELETE', path: '/api/org/locations/l2', body: undefined }]);
  });

  test('with one location the Name field says when its name shows, and the delete names the organization (D29)', async () => {
    const { api, fake } = setup();
    api.org = orgOf('org_admin', [only('l2')]);
    fake.deletes['/api/org/locations/l2'] = () => {
      api.org = orgOf('org_admin', []);
      return null;
    };
    await renderApp('/locations/l2/settings', api);
    expect(await screen.findByText('Shown only once Test Group has more than one location.')).toBeTruthy();
    // The field keeps the location's own name, for when a second location makes it show.
    expect(screen.getByLabelText('Name').props.value).toBe('River Grill');
    await fireEvent.press(screen.getByRole('button', { name: 'Delete location' }));
    expect(screen.getByRole('heading', { name: 'Delete Test Group?' })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Type Test Group to confirm.'), 'Test Group');
    await fireEvent.press(dialogButton('Delete location'));
    expect(await screen.findByText('Deleted Test Group.')).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'DELETE', path: '/api/org/locations/l2', body: undefined }]);
  });

  test('with several locations the Name field has no helper', async () => {
    await renderApp('/locations/l2/settings', setup().api);
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    expect(screen.queryByText(/^Shown only once/)).toBeNull();
  });

  test('Location settings links to Business rules', async () => {
    const { api } = setup();
    const { router } = await renderApp('/locations/l2/settings', api);
    expect(await screen.findByRole('heading', { name: 'Business rules' })).toBeTruthy();
    expect(screen.getByText('The standing facts TownwiseAI keeps in mind for River Grill. Only a rule with a schedule changes Townwise’s forecast.')).toBeTruthy();
    // A static section: it reads nothing, and the link opens the page.
    expect(api.calls.some((call) => call.path.endsWith('/rules'))).toBe(false);
    await fireEvent.press(screen.getByRole('link', { name: 'Edit business rules' }));
    expect(router.getPathname()).toBe('/locations/l2/rules');
    await cleanup();
    // With one location the line names the organization (D29).
    const one = setup();
    one.api.org = orgOf('org_admin', [only('l2')]);
    await renderApp('/locations/l2/settings', one.api);
    expect(await screen.findByText('The standing facts TownwiseAI keeps in mind for Test Group. Only a rule with a schedule changes Townwise’s forecast.')).toBeTruthy();
  });

  test('with one location, Add another location opens Add location, since Locations opens this Home', async () => {
    const { api } = setup();
    api.org = orgOf('org_admin', [only('l2')]);
    const { router } = await renderApp('/locations/l2/settings', api);
    await fireEvent.press(await screen.findByRole('link', { name: 'Add another location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/new'); });
  });

  test('the dialog counts days turned-off uploads hold, which coverage leaves out', () => {
    expect(deleteBody({ coverage: { dayCount: 0 }, offDayCount: 1, notesCount: 0 }, 'Test Group')).toBe('This deletes the location from Test Group with '
      + 'everything in it: 1 day of sales data, 0 notes, its stored files, business rules, ordering setup, calendars and TownwiseAI chats. This can’t be undone.');
  });

  test('while a file is being read, or stored files are off, the dialog says so and stays open', async () => {
    const { api, fake } = setup();
    let answer: 'import_running' | 'files_unavailable' = 'import_running';
    fake.deletes['/api/org/locations/l2'] = () => refusal(answer === 'import_running' ? 409 : 503, answer);
    await renderApp('/locations/l2/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete location' }));
    await fireEvent.changeText(screen.getByLabelText('Type River Grill to confirm.'), 'River Grill');
    await fireEvent.press(dialogButton('Delete location'));
    expect(await screen.findByText(DELETE_COPY.reading)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Delete River Grill?' })).toBeTruthy();
    answer = 'files_unavailable';
    await fireEvent.press(dialogButton('Delete location'));
    expect(await screen.findByText(DELETE_COPY.filesOff)).toBeTruthy();
  });

  test('view-as: every write is disabled in place, with the read-only line', async () => {
    const { api } = setup(viewAsMe(ACCESS.admin));
    await renderApp('/locations/l2/settings', api);
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    expect(screen.getByLabelText('Name').props.editable).toBe(false);
    for (const name of ['Save changes', 'Add another location', 'Delete location']) {
      const control = screen.getByRole('button', { name });
      expect(control.props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(control);
    }
    expect(screen.queryByRole('heading', { name: 'Delete River Grill?' })).toBeNull();
    expect(writes(api)).toEqual([]);
  });

  test('the switcher opens the other location’s settings fresh, with nothing carried over', async () => {
    const { api } = setup();
    const { router } = await renderApp('/locations/l1/settings', api);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Half typed');
    await fireEvent.press(screen.getByRole('button', { name: 'Location' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'River Grill' }));
    expect(router.getPathname()).toBe('/locations/l2/settings');
    await waitFor(() => { expect(screen.getByLabelText('Name').props.value).toBe('River Grill'); });
    expect(screen.getByRole('button', { name: 'Delete location' })).toBeTruthy();
  });

  test('members are sent to Locations', async () => {
    const { router } = await renderApp('/locations/l1/settings', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
  });
});

describe('P10 Add location', () => {
  test('the form adds the location and opens its Forecast tab', async () => {
    const { api } = setup();
    const added = locationOf('l9', 'Harbor Room', { townId: 'stowe-vt', name: 'Stowe', state: 'VT' });
    api.answers['/api/org/locations'] = () => {
      api.org = orgOf('org_admin', [...LOCATIONS, added]);
      return { location: added };
    };
    const { router } = await renderApp('/locations/new', api);
    expect(await screen.findByRole('heading', { name: 'Add location' })).toBeTruthy();
    expect(screen.getAllByText('Test Group').length).toBeGreaterThan(1);
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Harbor Room');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l9'); });
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/org/locations', body: { name: 'Harbor Room', town: { townId: 'stowe-vt' } } }]);
    expect(await screen.findByText('Harbor Room, Stowe, VT')).toBeTruthy();
  });

  test('D25: in open as admin the form also names the organization the page shows', async () => {
    const { api } = setup(openAsAdminMe());
    const added = locationOf('l9', 'Harbor Room', { townId: 'stowe-vt', name: 'Stowe', state: 'VT' });
    api.answers['/api/org/locations'] = () => {
      api.org = orgOf('org_admin', [...LOCATIONS, added]);
      return { location: added };
    };
    const { router } = await renderApp('/locations/new', api);
    expect(await screen.findByRole('heading', { name: 'Add location' })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Harbor Room');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l9'); });
    expect(writes(api)).toEqual([
      { method: 'POST', path: '/api/org/locations', body: { name: 'Harbor Room', town: { townId: 'stowe-vt' }, orgId: 'o1' } },
    ]);
  });

  test('Cancel returns to Locations', async () => {
    const { router } = await renderApp('/locations/new', setup().api);
    await fireEvent.press(await screen.findByRole('link', { name: 'Cancel' }));
    expect(router.getPathname()).toBe('/dashboard');
  });

  test('view-as: the form is read-only and Add location is disabled', async () => {
    const { api } = setup(viewAsMe(ACCESS.admin));
    await renderApp('/locations/new', api);
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    expect(screen.getByLabelText('Name').props.editable).toBe(false);
    const add = screen.getByRole('button', { name: 'Add location' });
    expect(add.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(add);
    expect(writes(api)).toEqual([]);
  });

  test('members are sent to Locations', async () => {
    const { router } = await renderApp('/locations/new', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
  });
});
