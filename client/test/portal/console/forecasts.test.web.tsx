import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { ApiError } from '../../../src/api/client';
import { ForecastRuns } from '../../../src/portal/console/ForecastRuns';
import { issueText, readRunFile, summaryText, type StaffRun } from '../../../src/portal/console/forecasts';
import { refusal, staffMe } from '../../helpers/portal';
import { portalWrapper } from '../files/harness';
import { consoleApi, orgDetail, type ConsoleApi } from './helpers';

// P21's Forecasts (spec 16.4, 14.4): runs by location with Publish only on drafts, Withdraw and Delete through
// dialogs that say the org's admins see it, the import's summary before anything is sent, problems listed by path
// and code in words (never a value from the file), and the server's issues read the same way. Staff only, so
// view-as does not apply. Every figure is synthetic.

afterEach(() => {
  cleanup();
});

const LIST = 'GET /api/admin/orgs/o1/forecast-runs';
const SENTINEL = 'Sentinel Guest Name';

function run(fields: Partial<StaffRun> = {}): StaffRun {
  return {
    id: 'run1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
    trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', locationId: 'l1', status: 'draft',
    range: { from: '2026-05-01', to: '2026-05-14' }, dayCount: 14, weekCount: 3, importedAt: '2026-05-02T15:00:00.000Z',
    publishedAt: null, withdrawnAt: null, importedByEmail: 'staff@example.com', ...fields,
  };
}

/** A synthetic run file: two open days, one closed. */
const FILE = {
  schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', notebookCommit: '0000000' },
  trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', frozen: null,
  interval: { level: 0.8, widened: true }, backtest: null,
  days: [
    { date: '2026-05-01', status: 'open', low: 80, mid: 100, high: 120, baseline: null, reasons: [{ kind: 'weekday', ref: null, effectPct: null }] },
    { date: '2026-05-02', status: 'open', low: 80, mid: 100, high: 120, baseline: null, reasons: [] },
    { date: '2026-05-04', status: 'closed', low: null, mid: null, high: null, baseline: null, reasons: [{ kind: 'closure', ref: null, effectPct: null }] },
  ],
  weeks: [],
};

const DETAIL = orgDetail({
  locations: [
    ...orgDetail().locations,
    { id: 'l2', name: 'Norwich', town: { townId: null, name: 'Norwich', state: 'VT' }, coverage: { dayCount: 0, firstDate: null, lastDate: null }, notesCount: 0, lastUploadAt: null },
  ],
});

async function show(runs: StaffRun[]): Promise<ConsoleApi> {
  const api = consoleApi();
  api.routes[LIST] = () => ({ runs });
  api.routes['GET /api/admin/orgs/o1/calibrations'] = () => ({ forecasts: { on: false, at: null }, calibrations: [] });
  const Wrapper = portalWrapper(api, staffMe());
  render(<Wrapper><ForecastRuns org={DETAIL.org} locations={DETAIL.locations} /></Wrapper>);
  await screen.findByRole('heading', { name: 'Hanover' });
  return api;
}

async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function jsonFile(text: string, size?: number): File {
  const file = new File([text], 'run.json', { type: 'application/json' });
  // jsdom's Blob has no text(); the importer reads files with File.text().
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function choose(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  await settle(() => { fireEvent.change(input, { target: { files: [file] } }); });
}

test('lists each location’s runs with model, dates, status and the right actions, and says so where there are none', async () => {
  await show([run(), run({ id: 'run2', status: 'published', publishedAt: '2026-05-03T15:00:00.000Z' }), run({ id: 'run3', status: 'withdrawn', withdrawnAt: '2026-05-04T15:00:00.000Z' }), run({ id: 'run4', status: 'importing' })]);
  expect(screen.getByText('A forecast is a draft until you publish it. While forecasts are on, a calibration that passes every check publishes itself. Sample Restaurant Group’s members and TownwiseAI see only published forecasts, never the model. Each import, publish, withdrawal and deletion is listed in Sample Restaurant Group’s Townwise staff activity.')).toBeTruthy();
  const table = screen.getByRole('region', { name: 'Forecasts for Hanover' });
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Model', 'Dates', 'Trained to', 'Made', 'Status', 'Source', 'Actions']);
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((row) => within(row).getAllByRole('cell')[4]?.textContent)).toEqual([
    'Draft', 'PublishedMay 3, 2026', 'WithdrawnMay 4, 2026', 'Import unfinishedImport the same file again to finish.',
  ]);
  const draft = rows[0];
  if (draft === undefined) throw new Error('no rows');
  expect(within(draft).getAllByRole('cell').slice(0, 4).map((cell) => cell.textContent)).toEqual([
    'v9', 'May 1, 2026 to May 14, 202614 days', 'Apr 30, 2026', 'May 1, 2026',
  ]);
  // Publish only on the draft; Withdraw on draft and published; Delete on every run.
  expect(screen.getAllByRole('button', { name: /^Publish / })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /^Withdraw / })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: /^Delete / })).toHaveLength(4);
  expect(screen.getByText('No forecast imported for Norwich.')).toBeTruthy();
});

test('Publish goes through a dialog that says the admins see it, then reads the runs again', async () => {
  const api = await show([run()]);
  api.routes['POST /api/admin/orgs/o1/forecast-runs/run1/publish'] = () => ({ run: run({ status: 'published', publishedAt: '2026-05-03T15:00:00.000Z' }) });
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Publish Townwise demand model v9, May 1, 2026' })); });
  const dialog = screen.getByRole('dialog', { name: 'Publish Townwise demand model v9 for Hanover?' });
  expect(within(dialog).getByText('Sample Restaurant Group’s members and TownwiseAI will see its ranges for May 1, 2026 to May 14, 2026. Its admins see this in their Townwise staff activity.')).toBeTruthy();
  api.routes[LIST] = () => ({ runs: [run({ status: 'published', publishedAt: '2026-05-03T15:00:00.000Z' })] });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' })); });
  expect(api.calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body])).toEqual([
    ['/api/admin/orgs/o1/forecast-runs/run1/publish', {}],
  ]);
  expect(screen.queryByRole('dialog', { name: 'Publish Townwise demand model v9 for Hanover?' })).toBeNull();
  expect(await screen.findByText('Published.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Publish / })).toBeNull();
});

test('a refused change shows in its dialog in plain words', async () => {
  const api = await show([run()]);
  api.routes['POST /api/admin/orgs/o1/forecast-runs/run1/publish'] = () => refusal(409, 'forecast_run_not_draft');
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Publish Townwise demand model v9, May 1, 2026' })); });
  const dialog = screen.getByRole('dialog', { name: 'Publish Townwise demand model v9 for Hanover?' });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' })); });
  expect(within(dialog).getByText('Only a draft can be published, and this one isn’t a draft anymore.')).toBeTruthy();
});

test('Publish while the organization’s forecasts are off says to switch them on, in the server’s words', async () => {
  const api = await show([run()]);
  api.routes['POST /api/admin/orgs/o1/forecast-runs/run1/publish'] = () => refusal(409, 'forecasts_off');
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Publish Townwise demand model v9, May 1, 2026' })); });
  const dialog = screen.getByRole('dialog', { name: 'Publish Townwise demand model v9 for Hanover?' });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' })); });
  expect(within(dialog).getByText('Forecasts are off for this organization. Switch them on first.')).toBeTruthy();
  expect(within(dialog).queryByText(/Reload the page/)).toBeNull();
});

test('Delete and Withdraw say what they do; Delete removes the run', async () => {
  const api = await show([run({ status: 'published', publishedAt: '2026-05-03T15:00:00.000Z' })]);
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw Townwise demand model v9, May 1, 2026' })); });
  const withdraw = screen.getByRole('dialog', { name: 'Withdraw Townwise demand model v9 for Hanover?' });
  expect(within(withdraw).getByText('Members and TownwiseAI stop seeing it. It stays listed here until you delete it. Its admins see this in their Townwise staff activity.')).toBeTruthy();
  await settle(() => { fireEvent.click(within(withdraw).getByRole('button', { name: 'Cancel' })); });
  api.routes['DELETE /api/admin/orgs/o1/forecast-runs/run1'] = () => undefined;
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Delete Townwise demand model v9, May 1, 2026' })); });
  const remove = screen.getByRole('dialog', { name: 'Delete Townwise demand model v9 for Hanover?' });
  expect(within(remove).getByText('This deletes its days and weeks, May 1, 2026 to May 14, 2026. This can’t be undone. Its admins see this in their Townwise staff activity.')).toBeTruthy();
  api.routes[LIST] = () => ({ runs: [] });
  await settle(() => { fireEvent.click(within(remove).getByRole('button', { name: 'Delete forecast' })); });
  expect(api.calls.some((call) => call.method === 'DELETE' && call.path === '/api/admin/orgs/o1/forecast-runs/run1')).toBe(true);
  expect(await screen.findByText('Deleted.')).toBeTruthy();
  expect(screen.getByText('No forecast imported for Hanover.')).toBeTruthy();
});

test('the import shows a summary of the file before sending it, and sends it as it is to the chosen location', async () => {
  const api = await show([]);
  expect(screen.getByRole('heading', { name: 'Import a forecast' })).toBeTruthy();
  await choose(jsonFile(JSON.stringify(FILE)));
  expect(screen.getByText('For Hanover: Model v9, guests, 3 days (2 open) from May 1, 2026 to May 4, 2026, trained to Apr 30, 2026, made May 1, 2026.')).toBeTruthy();
  expect(screen.getByText('Saved as a draft; owners and TownwiseAI see it only after you publish it.')).toBeTruthy();
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([]);
  api.routes['POST /api/admin/orgs/o1/locations/l1/forecast-runs'] = () => ({ run: run() });
  api.routes[LIST] = () => ({ runs: [run()] });
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Import for Hanover' })); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/admin/orgs/o1/locations/l1/forecast-runs', body: FILE }]);
  expect(await screen.findByText('Imported Townwise demand model v9 as a draft. Publish it below once you’ve checked it.')).toBeTruthy();
  expect(await screen.findByRole('region', { name: 'Forecasts for Hanover' })).toBeTruthy();
});

test('an indented file over 256 KB on disk is read at the size it will be sent, and accepted', async () => {
  await show([]);
  // The exporter indents its JSON; the browser sends it compact, which is what the 256 KB limit is on.
  const indented = `${JSON.stringify(FILE, null, 2)}${' '.repeat(300 * 1024)}`;
  await choose(jsonFile(indented));
  expect(screen.getByText('For Hanover: Model v9, guests, 3 days (2 open) from May 1, 2026 to May 4, 2026, trained to Apr 30, 2026, made May 1, 2026.')).toBeTruthy();
});

test('a file that isn’t a run file is refused in words, by path and code, without its values, and nothing is sent', async () => {
  const api = await show([]);
  await choose(jsonFile('not json'));
  expect(screen.getByText('The file isn’t a JSON file.')).toBeTruthy();
  await choose(jsonFile(JSON.stringify({ ...FILE, guestName: SENTINEL })));
  expect(screen.getByText('The file has a field Townwise doesn’t accept.')).toBeTruthy();
  // Over 256 KB as it would be sent, checked before the shape.
  await choose(jsonFile(JSON.stringify({ ...FILE, padding: 'x'.repeat(260 * 1024) })));
  expect(screen.getByText('The file is larger than 256 KB.')).toBeTruthy();
  // Over 2 MB on disk: refused without being read.
  const huge = new File([JSON.stringify(FILE)], 'run.json', { type: 'application/json' });
  Object.defineProperty(huge, 'size', { value: 3 * 1024 * 1024 });
  Object.defineProperty(huge, 'text', { value: () => { throw new Error('read a file over 2 MB'); } });
  await choose(huge);
  expect(screen.getByText('The file is larger than 2 MB.')).toBeTruthy();
  expect(document.body.textContent).not.toContain(SENTINEL);
  expect(screen.queryByRole('button', { name: /^Import for/ })).toBeNull();
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([]);
});

test('the server’s issues read through the same words', async () => {
  const api = await show([]);
  await choose(jsonFile(JSON.stringify(FILE)));
  api.routes['POST /api/admin/orgs/o1/locations/l1/forecast-runs'] = () => new ApiError('http', 'Invalid forecast file', {
    status: 400, code: 'invalid_forecast_file', detail: { issues: [{ path: 'days[1].high', code: 'below_mid' }, { path: 'madeAt', code: 'made_in_future' }] },
  });
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Import for Hanover' })); });
  expect(screen.getByText('days[1].high is lower than mid.')).toBeTruthy();
  expect(screen.getByText('madeAt is after today.')).toBeTruthy();
});

describe('reading a run file', () => {
  test('summarizes a valid file and words every issue', () => {
    const read = readRunFile(JSON.stringify(FILE));
    expect(read.ok).toBe(true);
    if (read.ok) expect(summaryText(read.summary)).toBe('Model v9, guests, 3 days (2 open) from May 1, 2026 to May 4, 2026, trained to Apr 30, 2026, made May 1, 2026.');
    const bad = readRunFile(JSON.stringify({ ...FILE, days: [{ ...FILE.days[0], status: 'maybe' }] }));
    expect(bad).toEqual({ ok: false, issues: [{ path: 'days[0].status', code: 'invalid_value' }] });
    expect(issueText({ path: 'x', code: 'something_new' })).toBe('x isn’t valid.');
  });

  test('takes the baseline engine’s family, seasonal_baseline (D42), and still refuses a family the server doesn’t know', () => {
    expect(readRunFile(JSON.stringify({ ...FILE, model: { ...FILE.model, family: 'seasonal_baseline' } })).ok).toBe(true);
    expect(readRunFile(JSON.stringify({ ...FILE, model: { ...FILE.model, family: 'something_new' } }))).toEqual({
      ok: false, issues: [{ path: 'model.family', code: 'invalid_value' }],
    });
  });
});

describe('the weekly refresh (D42)', () => {
  const CALS = 'GET /api/admin/orgs/o1/calibrations';
  const SCHEDULE = 'POST /api/admin/forecast-schedule';
  const scheduled = {
    id: 'c9', locationId: 'l1', status: 'succeeded', failure: null, failureWords: null, via: 'scheduled', requestedByRole: 'system',
    regimeStart: null, requestedAt: '2026-11-23T08:10:00.000Z', startedAt: '2026-11-23T08:10:05.000Z', finishedAt: '2026-11-23T08:20:00.000Z',
    runId: 'run9', chargedUsd: 0, gate: { published: true, reason: 'refreshed', words: 'Published with the newest weeks.' }, summary: null,
  };

  async function showWeekly(list: Record<string, unknown>): Promise<ConsoleApi> {
    const api = consoleApi();
    api.routes[LIST] = () => ({ runs: [] });
    api.routes[CALS] = () => ({ forecasts: { on: true, at: null }, calibrations: [], ...list });
    const Wrapper = portalWrapper(api, staffMe());
    render(<Wrapper><ForecastRuns org={DETAIL.org} locations={DETAIL.locations} /></Wrapper>);
    await screen.findByRole('heading', { name: 'Weekly refresh' });
    return api;
  }

  test('shows each location’s latest week with its calibration’s gate, and a location with none', async () => {
    await showWeekly({
      schedule: { running: true, paused: null },
      weeks: [{ locationId: 'l1', week: '2026-11-23', outcome: 'started', calibrationId: 'c9' }],
      calibrations: [scheduled],
    });
    expect(screen.getByText('On: Townwise refits each changed location from 03:00 every Monday in its town, at no charge to the organization.')).toBeTruthy();
    expect(screen.getByText('Hanover: Mon, Nov 23, 2026: started, published (refreshed)')).toBeTruthy();
    expect(screen.getByText('Norwich: No weekly refresh yet.')).toBeTruthy();
    expect(screen.getByText('Started by Townwise (weekly)')).toBeTruthy();
  });

  test('words a skipped week', async () => {
    await showWeekly({
      schedule: { running: true, paused: null },
      weeks: [
        { locationId: 'l1', week: '2026-11-23', outcome: 'unchanged', calibrationId: null },
        { locationId: 'l2', week: '2026-11-23', outcome: 'not_enough_history', calibrationId: null },
      ],
    });
    expect(screen.getByText('Hanover: Mon, Nov 23, 2026: unchanged')).toBeTruthy();
    expect(screen.getByText('Norwich: Mon, Nov 23, 2026: not enough history yet')).toBeTruthy();
  });

  test('Pause asks first, posts paused true, and then says who paused it and when', async () => {
    const api = await showWeekly({ schedule: { running: true, paused: null }, weeks: [] });
    await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Pause weekly refresh' })); });
    const dialog = screen.getByRole('dialog', { name: 'Pause the weekly refresh for every organization?' });
    expect(within(dialog).getByText('No scheduled calibration starts and no weekly suggestions are made from the next hourly pass until you resume it. Calibrations already running finish. It is recorded in the audit log.')).toBeTruthy();
    const paused = { running: true, paused: { at: '2026-11-23T15:00:00.000Z', email: 'staff@example.com' } };
    api.routes[SCHEDULE] = () => ({ schedule: paused });
    api.routes[CALS] = () => ({ forecasts: { on: true, at: null }, calibrations: [], schedule: paused, weeks: [] });
    await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' })); });
    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/admin/forecast-schedule', body: { paused: true } }]);
    expect(await screen.findByText('Paused by staff@example.com on Nov 23, 2026.')).toBeTruthy();
    await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Resume weekly refresh' })); });
    api.routes[SCHEDULE] = () => ({ schedule: { running: true, paused: null } });
    const resume = screen.getByRole('dialog', { name: 'Resume the weekly refresh for every organization?' });
    expect(within(resume).getByText('Scheduled calibrations and weekly suggestions start again from the next hourly pass. It is recorded in the audit log.')).toBeTruthy();
    await settle(() => { fireEvent.click(within(resume).getByRole('button', { name: 'Resume' })); });
    expect(api.calls.filter((call) => call.method === 'POST').at(-1)).toEqual({ method: 'POST', path: '/api/admin/forecast-schedule', body: { paused: false } });
  });

  test('says it isn’t running, with no pause button, while the lab is off', async () => {
    await showWeekly({ schedule: { running: false, paused: null }, weeks: [] });
    expect(screen.getByText('The weekly refresh isn’t running here: the forecast lab or its switch is off.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause weekly refresh' })).toBeNull();
  });

  test('an API from before the worker (no schedule) shows no weekly refresh, and the rest still loads', async () => {
    const api = consoleApi();
    api.routes[LIST] = () => ({ runs: [] });
    api.routes[CALS] = () => ({ forecasts: { on: false, at: null }, calibrations: [] });
    const Wrapper = portalWrapper(api, staffMe());
    render(<Wrapper><ForecastRuns org={DETAIL.org} locations={DETAIL.locations} /></Wrapper>);
    await screen.findByRole('heading', { name: 'Calibrations' });
    expect(screen.queryByRole('heading', { name: 'Weekly refresh' })).toBeNull();
  });
});

