import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { OrgDetail, OrgLocation } from '../../../src/portal/console/schemas';
import { refusal } from '../../helpers/portal';
import { installPlaces } from '../onboarding/places-fakes';
import { consoleApi, emailOf, member, orgDetail, renderAt, type ConsoleApi } from './helpers';

// P21's setup panel (docs/portal/spec.md 16.4, D23, F10b): only while the organization is in setup; add, rename and
// delete locations and upload or delete their daily totals through the setup routes (10.7), reading the organization
// again after each; a 409 org_not_in_setup closes it; and no figure ever shows (D7). The file here is synthetic.

afterEach(() => {
  cleanup();
});

const NAME = 'Sample Restaurant Group';
const PATH = '/api/admin/orgs/o1';
const SETUP = `${PATH}/locations`;
const HEADING = 'Set up before anyone joins';
const BODY = `Nobody has joined ${NAME} yet. You can add its locations and upload their daily totals so its first admin finds a ready page. Use this only with ${NAME}’s consent. Each change is listed in ${NAME}’s Townwise staff activity, and setup closes for good when the first person joins.`;
const CLOSED = `Someone joined ${NAME}, so setup is closed. Use View as to see their page.`;

const HANOVER_TOWN = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };

function hanover(coverage?: OrgLocation['coverage']): OrgLocation {
  return {
    id: 'l1', name: 'Hanover', town: HANOVER_TOWN, coverage: coverage ?? { dayCount: 0, firstDate: null, lastDate: null },
    notesCount: 0, lastUploadAt: null,
  };
}

/** An organization in setup: created by staff, with only its first admin's invitation. */
function inSetup(locations: OrgLocation[]): OrgDetail {
  return orgDetail({
    org: { fromRequestId: null, inSetup: true },
    members: [member('m9', emailOf('owner', 'example.org'), { role: 'org_admin', status: 'invited', joinedAt: null, addedByStaff: true })],
    locations,
    recent: [],
  });
}

/** The answer of a setup location write, as the API sends it (a LocationSummary). */
function summary(name: string): unknown {
  return {
    location: {
      id: 'l1', name, town: HANOVER_TOWN, placeId: null,
      coverage: { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 },
      calibration: { state: 'no_sales_data' }, notesCount: 0, lastUploadAt: null,
    },
  };
}

function serve(api: ConsoleApi, read: () => unknown): void {
  api.routes[`GET ${PATH}`] = read;
  api.routes[`GET ${PATH}/forecast-runs`] = () => ({ runs: [] });
}

function gets(api: ConsoleApi): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === PATH).length;
}

/** The setup writes, without the panel's one Places check. */
function setupWrites(api: ConsoleApi): { method: string; path: string; body: unknown }[] {
  return api.calls.filter((call) => call.method !== 'GET' && call.path.startsWith(SETUP));
}

/** Fires an event and lets the reads and writes it starts settle inside act. */
async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function click(name: string, within_?: HTMLElement): Promise<void> {
  const scope = within_ === undefined ? screen : within(within_);
  return settle(() => { fireEvent.click(scope.getByRole('button', { name })); });
}

test.each<[string, boolean | undefined]>([
  ['absent', undefined],
  ['false', false],
])('inSetup %s: no setup panel, and the page as before', async (_name, value) => {
  const api = consoleApi();
  serve(api, () => orgDetail({ org: value === undefined ? {} : { inSetup: value }, locations: [] }));
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByRole('heading', { level: 1, name: NAME })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add location' })).toBeNull();
  expect(screen.getByText('No locations yet. The first admin adds one after joining.')).toBeTruthy();
  // Not even the Places check is sent.
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('in setup: the panel, its copy, and the Locations empty state pointing at it', async () => {
  const api = consoleApi();
  serve(api, () => inSetup([]));
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByRole('heading', { name: HEADING })).toBeTruthy();
  expect(screen.getByText('Staff setup')).toBeTruthy();
  expect(screen.getByText(BODY)).toBeTruthy();
  expect(screen.getByText('No locations yet. Add the first one below.')).toBeTruthy();
  expect(screen.queryByText('No locations yet. The first admin adds one after joining.')).toBeNull();
  expect(await screen.findByRole('button', { name: 'Add location' })).toBeTruthy();
  expect(screen.getByText(`Add a location to ${NAME} first, then upload its daily totals.`)).toBeTruthy();
});

test('Add a location sends the setup route, reads the organization again, and starts the form over', async () => {
  const api = consoleApi();
  let detail = inSetup([]);
  serve(api, () => detail);
  api.routes[`POST ${SETUP}`] = () => {
    detail = inSetup([hanover()]);
    return summary('Hanover');
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: ' Hanover ' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Town' }), { target: { value: 'hanover-nh' } });
  await click('Add location');
  expect(await screen.findByText('Added Hanover.')).toBeTruthy();
  expect(setupWrites(api)).toEqual([{ method: 'POST', path: SETUP, body: { name: 'Hanover', town: { townId: 'hanover-nh' } } }]);
  // Nothing went to the org admin route.
  expect(api.calls.some((call) => call.path === '/api/org/locations')).toBe(false);
  expect(gets(api)).toBe(2);
  const locations = screen.getByRole('region', { name: 'Locations' });
  expect(within(locations).getByText('Hanover')).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('');
});

test('Add a location: the Places search leads while it is on, as on P10', async () => {
  const api = consoleApi();
  serve(api, () => inSetup([]));
  // The search is on: autocomplete checks its key before the body (onboarding/places.ts checkPlaceSearch).
  api.routes['POST /api/places/autocomplete'] = () => refusal(400, 'invalid_request');
  renderAt('/admin/orgs/o1', api);
  expect(await screen.findByRole('combobox', { name: 'Search Google Maps for the location' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
  expect(api.calls.filter((call) => call.path === '/api/places/autocomplete')).toHaveLength(1);
});

test('a location name another location uses is said under the field, as on P10', async () => {
  const api = consoleApi();
  serve(api, () => inSetup([hanover()]));
  api.routes[`POST ${SETUP}`] = () => refusal(409, 'location_name_taken');
  renderAt('/admin/orgs/o1', api);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Hanover' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Town' }), { target: { value: 'hanover-nh' } });
  await click('Add location');
  expect(await screen.findByText('Another location already uses that name.')).toBeTruthy();
  expect(gets(api)).toBe(1);
});

test('Rename sends the name and town to the setup route, then says Saved.', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover()]);
  serve(api, () => detail);
  api.routes[`PATCH ${SETUP}/l1`] = (body) => {
    detail = inSetup([{ ...hanover(), name: (body as { name: string }).name }]);
    return summary((body as { name: string }).name);
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Hanover' }));
  const dialog = screen.getByRole('dialog', { name: 'Rename Hanover' });
  const field = within(dialog).getByRole('textbox', { name: 'Name' });
  expect((field as HTMLInputElement).value).toBe('Hanover');
  fireEvent.change(field, { target: { value: 'Hanover Inn' } });
  await click('Save changes', dialog);
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Rename Hanover' })).toBeNull();
  expect(setupWrites(api)).toEqual([{ method: 'PATCH', path: `${SETUP}/l1`, body: { name: 'Hanover Inn', town: { townId: 'hanover-nh' } } }]);
  expect(gets(api)).toBe(2);
});

test('Rename with a place on Google Maps sends its id and town, as P16 does', async () => {
  const api = consoleApi();
  const places = installPlaces(api, { results: { Lou: [{ placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', detail: 'Norwich, VT, USA' }] } });
  serve(api, () => inSetup([hanover()]));
  api.routes[`PATCH ${SETUP}/l1`] = () => summary('Lou’s Bakery');
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Hanover' }));
  const dialog = screen.getByRole('dialog', { name: 'Rename Hanover' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Search Google Maps instead' }));
  // Save waits for the place: the search is the dialog's step for now.
  expect(within(dialog).getByRole('button', { name: 'Save changes' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search Google Maps for this location' }), { target: { value: 'Lou' } });
  const option = await within(dialog).findByRole('option', { name: /Lou’s Bakery/ });
  fireEvent.mouseDown(option);
  await settle(() => { fireEvent.click(option); });
  expect(await within(dialog).findByText('Using this place moves Hanover to Norwich, VT.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Looks right' }));
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Lou’s Bakery' } });
  await click('Save changes', dialog);
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(setupWrites(api)).toEqual([{
    method: 'PATCH',
    path: `${SETUP}/l1`,
    body: { name: 'Lou’s Bakery', town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: 'ChIJTestPlace0002' },
  }]);
  // One check for the whole panel, as P3 makes it.
  expect(places.checks).toBe(1);
});

test('Delete sales data confirms with the typed name first, then shows the counts deleted', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover({ dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-02-04' })]);
  serve(api, () => detail);
  api.routes[`DELETE ${SETUP}/l1/sales`] = () => {
    detail = inSetup([hanover()]);
    return { deletedDays: 400, deletedUploads: 2, deletedFiles: 0 };
  };
  renderAt('/admin/orgs/o1', api);
  // A location with days can't be deleted yet.
  await screen.findByRole('button', { name: 'Delete Hanover’s sales data' });
  expect(screen.queryByRole('button', { name: 'Delete Hanover' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Hanover’s sales data' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Hanover’s sales data?' });
  expect(within(dialog).getByText(`This deletes its 400 days of daily totals, its uploads and any stored files. This can’t be undone. It’s listed in ${NAME}’s Townwise staff activity.`)).toBeTruthy();
  expect(setupWrites(api)).toEqual([]);
  const confirm = within(dialog).getByRole('button', { name: 'Delete sales data' });
  expect(confirm.getAttribute('aria-disabled')).toBe('true');
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type Hanover to confirm.' }), { target: { value: 'Hanover' } });
  await click('Delete sales data', dialog);
  expect(await screen.findByText('Deleted 400 days and 2 uploads from Hanover.')).toBeTruthy();
  expect(setupWrites(api)).toEqual([{ method: 'DELETE', path: `${SETUP}/l1/sales`, body: undefined }]);
  expect(gets(api)).toBe(2);
  // Empty now, so it can be deleted.
  expect(screen.getByRole('button', { name: 'Delete Hanover' })).toBeTruthy();
});

test('Delete sales data: a running import and stored files off are said in the dialog', async () => {
  const api = consoleApi();
  serve(api, () => inSetup([hanover({ dayCount: 3, firstDate: '2025-03-04', lastDate: '2025-03-07' })]));
  let answer = refusal(409, 'import_running');
  api.routes[`DELETE ${SETUP}/l1/sales`] = () => answer;
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Hanover’s sales data' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Hanover’s sales data?' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type Hanover to confirm.' }), { target: { value: 'Hanover' } });
  await click('Delete sales data', dialog);
  expect(within(dialog).getByText('Townwise is reading files for this location. Try again when it’s done.')).toBeTruthy();
  answer = refusal(503, 'files_unavailable');
  await click('Delete sales data', dialog);
  expect(within(dialog).getByText('Stored files are off right now, so nothing was deleted. Try again later.')).toBeTruthy();
  expect(gets(api)).toBe(1);
});

test('Delete location: only an empty one, confirmed with the typed name first', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover()]);
  serve(api, () => detail);
  api.routes[`DELETE ${SETUP}/l1`] = () => {
    detail = inSetup([]);
    return null;
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Hanover' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Hanover?' });
  expect(within(dialog).getByText(`This deletes the location from ${NAME}. This can’t be undone. It’s listed in ${NAME}’s Townwise staff activity.`)).toBeTruthy();
  expect(setupWrites(api)).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Delete Hanover?' })).toBeNull();
  expect(setupWrites(api)).toEqual([]);

  fireEvent.click(screen.getByRole('button', { name: 'Delete Hanover' }));
  const again = screen.getByRole('dialog', { name: 'Delete Hanover?' });
  fireEvent.change(within(again).getByRole('textbox', { name: 'Type Hanover to confirm.' }), { target: { value: 'Hanover' } });
  await click('Delete location', again);
  expect(await screen.findByText('Deleted Hanover.')).toBeTruthy();
  expect(setupWrites(api)).toEqual([{ method: 'DELETE', path: `${SETUP}/l1`, body: undefined }]);
  expect(screen.getByText('No locations yet. Add the first one below.')).toBeTruthy();
});

test('409 org_not_in_setup: the page reads again without the panel and says someone joined', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover()]);
  serve(api, () => detail);
  api.routes[`POST ${SETUP}`] = () => {
    // The invited admin joined meanwhile.
    detail = orgDetail({ org: { fromRequestId: null, inSetup: false }, locations: [hanover()], recent: [] });
    return refusal(409, 'org_not_in_setup');
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Lebanon' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Town' }), { target: { value: 'hanover-nh' } });
  await click('Add location');
  expect(await screen.findByText(CLOSED)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add location' })).toBeNull();
  await waitFor(() => { expect(gets(api)).toBe(2); });
  // No shared error copy in place of the notice.
  expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
});

test('409 org_not_in_setup when another staff member suspended it: the notice says so', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover()]);
  serve(api, () => detail);
  api.routes[`DELETE ${SETUP}/l1`] = () => {
    detail = orgDetail({ org: { fromRequestId: null, status: 'suspended', inSetup: false }, locations: [hanover()], recent: [] });
    return refusal(409, 'org_not_in_setup');
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Hanover' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Hanover?' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type Hanover to confirm.' }), { target: { value: 'Hanover' } });
  await click('Delete location', dialog);
  expect(await screen.findByText(`${NAME} was suspended, so setup is closed.`)).toBeTruthy();
  expect(screen.queryByText(CLOSED)).toBeNull();
  expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  expect(screen.getByText('Suspended')).toBeTruthy();
  expect(gets(api)).toBe(2);
});

test('409 org_not_in_setup closes the panel even when the read after it fails', async () => {
  const api = consoleApi();
  let fail = false;
  serve(api, () => (fail ? refusal(503, 'unavailable') : inSetup([hanover({ dayCount: 3, firstDate: '2025-03-04', lastDate: '2025-03-07' })])));
  api.routes[`DELETE ${SETUP}/l1/sales`] = () => {
    fail = true;
    return refusal(409, 'org_not_in_setup');
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Hanover’s sales data' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Hanover’s sales data?' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type Hanover to confirm.' }), { target: { value: 'Hanover' } });
  await click('Delete sales data', dialog);
  expect(await screen.findByText(CLOSED)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(await screen.findByText('This page couldn’t load the latest, so it may be out of date.')).toBeTruthy();
});

test('a 404 on a location write: the location was deleted meanwhile, and the page reads again', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover()]);
  serve(api, () => detail);
  api.routes[`DELETE ${SETUP}/l1`] = () => {
    detail = inSetup([]);
    return refusal(404, 'not_found');
  };
  renderAt('/admin/orgs/o1', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Hanover' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Hanover?' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type Hanover to confirm.' }), { target: { value: 'Hanover' } });
  await click('Delete location', dialog);
  expect(await screen.findByText('Hanover was deleted meanwhile.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(gets(api)).toBe(2);
});

// The upload: guests and net sales here are figures that must never reach the screen.
const FILE = [
  'Business Date,Guest Count,Net Sales',
  '2025-03-04,4321,98765.43',
  '2025-03-05,8642,87654.32',
  '2025-03-07,7531,76543.21',
].join('\n');
const FIGURES = ['4321', '4,321', '8642', '8,642', '7531', '7,531', '98765', '98,765', '87654', '87,654', '76543', '76,543', '$', '20494', '20,494', '262963', '262,963'];

function csvFile(text: string): File {
  const file = new File([text], 'export.csv', { type: 'text/csv' });
  // jsdom's Blob has no text(); the reader uses File.text() (spec 11.1).
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  return file;
}

function setupFileInput(): HTMLInputElement {
  // The Forecasts import has a file input too; the setup upload's takes CSV.
  const input = document.querySelector<HTMLInputElement>('input[type="file"][accept^=".csv"]');
  if (input === null) throw new Error('no setup file input');
  return input;
}

function pageText(): string {
  return document.body.textContent;
}

test('Upload daily totals: parsed in the browser, only { days } sent, and only the day count and dates shown', async () => {
  const api = consoleApi();
  let detail = inSetup([hanover()]);
  serve(api, () => detail);
  api.routes[`POST ${SETUP}/l1/sales/uploads`] = () => {
    detail = inSetup([hanover({ dayCount: 3, firstDate: '2025-03-04', lastDate: '2025-03-07' })]);
    return {
      upload: {
        id: 'up1', uploadedAt: '2026-11-08T15:00:00.000Z', uploadedByEmail: 'Townwise staff', status: 'applied', dayCount: 3,
        inserted: 3, replaced: 0, kept: 0, firstDate: '2025-03-04', lastDate: '2025-03-07', hasGuests: true, hasNetSales: true,
      },
      coverage: { dayCount: 3, guestsDayCount: 3, netSalesDayCount: 3, firstDate: '2025-03-04', lastDate: '2025-03-07', missingDays: 1, netSalesCents: 26296296 },
      calibration: { state: 'not_calibrated', dayCount: 3, firstDate: '2025-03-04', lastDate: '2025-03-07', guests: 20494 },
    };
  };
  renderAt('/admin/orgs/o1', api);
  await screen.findByRole('heading', { name: 'Upload daily totals' });
  // Named apart from the Forecasts import's Location select on the same page.
  expect(screen.getByRole('combobox', { name: 'Upload for' })).toBeTruthy();
  await settle(() => { fireEvent.change(setupFileInput(), { target: { files: [csvFile(FILE)] } }); });

  expect(await screen.findByRole('heading', { name: 'Match columns' })).toBeTruthy();
  expect(screen.getByText('For Hanover.')).toBeTruthy();
  // The console has no Cancel link here: Back ends the upload.
  expect(screen.queryByRole('link', { name: 'Cancel' })).toBeNull();
  for (const figure of FIGURES) expect(pageText()).not.toContain(figure);
  await click('Check the totals');

  expect(await screen.findByRole('heading', { name: 'Check the days' })).toBeTruthy();
  expect(screen.getByText('3 days for Hanover, Mar 4, 2025 to Mar 7, 2025.')).toBeTruthy();
  expect(screen.queryByText('Totals in this file')).toBeNull();
  for (const figure of FIGURES) expect(pageText()).not.toContain(figure);
  expect(setupWrites(api)).toEqual([]);

  await click('Send 3 days');
  expect(await screen.findByText('Saved 3 days for Hanover, Mar 4, 2025 to Mar 7, 2025.')).toBeTruthy();
  expect(screen.getByText('Hanover now has 3 days, Mar 4, 2025 to Mar 7, 2025.')).toBeTruthy();
  expect(setupWrites(api)).toEqual([{
    method: 'POST',
    path: `${SETUP}/l1/sales/uploads`,
    body: {
      days: [
        { date: '2025-03-04', guests: 4321, netSalesCents: 9_876_543 },
        { date: '2025-03-05', guests: 8642, netSalesCents: 8_765_432 },
        { date: '2025-03-07', guests: 7531, netSalesCents: 7_654_321 },
      ],
    },
  }]);
  // The Locations table shows the days from the read after the upload.
  expect(gets(api)).toBe(2);
  const locations = screen.getByRole('region', { name: 'Locations' });
  expect(within(locations).getAllByText('Mar 4, 2025').length).toBeGreaterThan(0);
  for (const figure of FIGURES) expect(pageText()).not.toContain(figure);
  expect(pageText()).not.toContain('26296296');
  expect(screen.getByRole('button', { name: 'Upload another file' })).toBeTruthy();
});

test('Upload daily totals: a refused send shows the shared copy, never a value', async () => {
  const api = consoleApi();
  serve(api, () => inSetup([hanover()]));
  api.routes[`POST ${SETUP}/l1/sales/uploads`] = () => refusal(503, 'unavailable');
  renderAt('/admin/orgs/o1', api);
  await screen.findByRole('heading', { name: 'Upload daily totals' });
  await settle(() => { fireEvent.change(setupFileInput(), { target: { files: [csvFile(FILE)] } }); });
  await screen.findByRole('heading', { name: 'Match columns' });
  await click('Check the totals');
  await click('Send 3 days');
  expect(await screen.findByText('The upload didn’t finish, and some days may have saved. Send again. Days are never duplicated.')).toBeTruthy();
  for (const figure of FIGURES) expect(pageText()).not.toContain(figure);
  expect(screen.getByRole('button', { name: 'Send 3 days' })).toBeTruthy();
});
