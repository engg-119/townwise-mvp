import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { ApiError } from '../../../src/api/client';
import { REFUSALS } from '../../../src/portal/console/CalibrationsPanel';
import { ForecastRuns } from '../../../src/portal/console/ForecastRuns';
import type { StaffRun } from '../../../src/portal/console/forecasts';
import { portalWrapper } from '../files/harness';
import { staffMe } from '../../helpers/portal';
import { consoleApi, orgDetail, type ConsoleApi } from './helpers';

// The Forecasts section's calibrations (forecast lab design call 8): the organization's forecasts switch with the
// owner-agreed attestation, a Calibrate button per location with its cost and optional pattern-change date, the
// calibrations list in the server's words and percentages only, and the runs table's source. Every figure is synthetic.

afterEach(() => {
  cleanup();
});

const RUNS = 'GET /api/admin/orgs/o1/forecast-runs';
const CALS = 'GET /api/admin/orgs/o1/calibrations';
const SWITCH = 'POST /api/admin/orgs/o1/forecasts-switch';
const START = 'POST /api/admin/orgs/o1/locations/l1/calibrations';

function calibration(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1', locationId: 'l1', status: 'succeeded', failure: null, failureWords: null, via: 'console', requestedByRole: 'superadmin',
    regimeStart: null, requestedAt: '2026-11-02T15:00:00.000Z', startedAt: '2026-11-02T15:00:05.000Z', finishedAt: '2026-11-02T15:08:00.000Z',
    runId: 'run1', chargedUsd: 0.1,
    gate: { published: true, reason: 'better', words: 'It beat the current forecast on every check, so it was published.' },
    summary: {
      weeks: 12, weeklyWapePct: 8.4, championWeeklyWapePct: 10.1, coverage: { inside: 10, weeks: 12 }, weekdayBiasPct: 3.2, championWeekdayBiasPct: 4,
    },
    ...fields,
  };
}

function run(fields: Partial<StaffRun> = {}): StaffRun {
  return {
    id: 'run1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
    trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', locationId: 'l1',
    status: 'draft', range: { from: '2026-05-01', to: '2026-05-14' }, dayCount: 14, weekCount: 3, importedAt: '2026-05-02T15:00:00.000Z',
    publishedAt: null, withdrawnAt: null, importedByEmail: 'staff@example.com', ...fields,
  };
}

const DETAIL = orgDetail();
/** A synthetic guest figure on the payload that must never render. */
const SENTINEL = 98_765;

async function show(options: { on?: boolean; calibrations?: unknown[]; runs?: StaffRun[] } = {}): Promise<ConsoleApi> {
  const api = consoleApi();
  api.routes[RUNS] = () => ({ runs: options.runs ?? [] });
  api.routes[CALS] = () => ({
    forecasts: { on: options.on ?? false, at: options.on === true ? '2026-11-03T12:00:00.000Z' : null },
    calibrations: options.calibrations ?? [],
  });
  const Wrapper = portalWrapper(api, staffMe());
  render(<Wrapper><ForecastRuns org={DETAIL.org} locations={DETAIL.locations} /></Wrapper>);
  await screen.findByRole('heading', { name: 'Calibrations' });
  return api;
}

async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

const ORG = DETAIL.org.name;

test('shows forecasts off with Switch on; switching on needs the owner-agreed checkbox and posts ownerAgreed true', async () => {
  const api = await show();
  expect(screen.getByText(`Forecasts are off for ${ORG}. Nothing is published, by you or by a calibration, until they’re on.`)).toBeTruthy();
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Switch on' })); });
  const dialog = screen.getByRole('dialog', { name: `Switch on forecasts for ${ORG}?` });
  expect(within(dialog).getByText(`Owners and TownwiseAI will see forecasts you publish, and calibrations that pass every check will publish themselves. Switch on only once ${ORG}’s owner has agreed to see forecasts and to their being sent to Anthropic through TownwiseAI. Its admins see this in their Townwise staff activity.`)).toBeTruthy();
  const confirm = within(dialog).getByRole('button', { name: 'Switch on' });
  expect(confirm.hasAttribute('disabled') || confirm.getAttribute('aria-disabled') === 'true').toBe(true);
  await settle(() => { fireEvent.click(within(dialog).getByRole('checkbox', { name: `${ORG}’s owner agreed` })); });
  api.routes[SWITCH] = () => ({ forecasts: { on: true, at: '2026-11-03T12:00:00.000Z' } });
  api.routes[CALS] = () => ({ forecasts: { on: true, at: '2026-11-03T12:00:00.000Z' }, calibrations: [] });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Switch on' })); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/admin/orgs/o1/forecasts-switch', body: { on: true, ownerAgreed: true } }]);
  expect(await screen.findByText(`Forecasts are on for ${ORG} since Nov 3, 2026.`)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Switch off' })).toBeTruthy();
});

test('switching off says what stays and posts on false', async () => {
  const api = await show({ on: true });
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Switch off' })); });
  const dialog = screen.getByRole('dialog', { name: `Switch off forecasts for ${ORG}?` });
  expect(within(dialog).getByText('Nothing more is published until they’re back on; passing calibrations stay drafts. Forecasts already published stay until you withdraw them. Its admins see this in their Townwise staff activity.')).toBeTruthy();
  api.routes[SWITCH] = () => ({ forecasts: { on: false, at: '2026-11-04T12:00:00.000Z' } });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' })); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/admin/orgs/o1/forecasts-switch', body: { on: false } }]);
});

test('Calibrate opens the dialog with the cost and optional date, posts it, and lists the new calibration', async () => {
  const api = await show();
  expect(screen.getByText('No calibrations yet.')).toBeTruthy();
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Calibrate Hanover' })); });
  const dialog = screen.getByRole('dialog', { name: 'Calibrate Hanover?' });
  expect(within(dialog).getByText(`Townwise refits Hanover’s forecast on its sales history and notes, on Townwise’s servers, and scores it on held-out weeks. It costs $0.10 of ${ORG}’s TownwiseAI budget. If it passes every check and forecasts are on, it publishes itself. Its admins see this in their Townwise staff activity.`)).toBeTruthy();
  expect(within(dialog).getByText('The first day of a lasting change, such as the day lunch service ended.')).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText('Weekly pattern changed on (optional)'), { target: { value: '2026-09-01' } });
  api.routes[START] = () => ({ calibration: calibration({ status: 'queued', gate: null, summary: null, startedAt: null, finishedAt: null, runId: null }) });
  api.routes[CALS] = () => ({ forecasts: { on: false, at: null }, calibrations: [calibration({ status: 'queued', gate: null, summary: null, startedAt: null, finishedAt: null, runId: null })] });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Calibrate' })); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/admin/orgs/o1/locations/l1/calibrations', body: { regimeStart: '2026-09-01' } }]);
  expect(await screen.findByText('Started.')).toBeTruthy();
  expect(screen.getByText('Waiting to start')).toBeTruthy();
});

test('Calibrate without a date posts none', async () => {
  const api = await show();
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Calibrate Hanover' })); });
  api.routes[START] = () => ({ calibration: calibration() });
  await settle(() => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Calibrate Hanover?' })).getByRole('button', { name: 'Calibrate' })); });
  expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({});
});

test('a malformed pattern-change date says the form and keeps Calibrate disabled', async () => {
  const api = await show();
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Calibrate Hanover' })); });
  const dialog = screen.getByRole('dialog', { name: 'Calibrate Hanover?' });
  await settle(() => { fireEvent.change(within(dialog).getByLabelText('Weekly pattern changed on (optional)'), { target: { value: '9/1/2026' } }); });
  expect(within(dialog).getByText('Use the form YYYY-MM-DD.')).toBeTruthy();
  const confirm = within(dialog).getByRole('button', { name: 'Calibrate' });
  expect(confirm.hasAttribute('disabled') || confirm.getAttribute('aria-disabled') === 'true').toBe(true);
  await settle(() => { fireEvent.click(confirm); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([]);
});

test('each location’s Calibrate sits beside its name', async () => {
  const two = orgDetail({
    locations: [
      ...orgDetail().locations,
      { id: 'l2', name: 'Norwich', town: { townId: null, name: 'Norwich', state: 'VT' }, coverage: { dayCount: 0, firstDate: null, lastDate: null }, notesCount: 0, lastUploadAt: null },
    ],
  });
  const api = consoleApi();
  api.routes[RUNS] = () => ({ runs: [] });
  api.routes[CALS] = () => ({ forecasts: { on: false, at: null }, calibrations: [] });
  const Wrapper = portalWrapper(api, staffMe());
  render(<Wrapper><ForecastRuns org={two.org} locations={two.locations} /></Wrapper>);
  await screen.findByRole('heading', { name: 'Calibrations' });
  for (const name of ['Hanover', 'Norwich']) {
    const button = screen.getByRole('button', { name: `Calibrate ${name}` });
    expect(button.parentElement?.textContent).toContain(name);
  }
});

test('the start refusals are the server’s own words (START_REFUSAL_WORDS)', () => {
  const server = readFileSync(join(__dirname, '..', '..', '..', '..', 'api', 'src', 'lab', 'service.ts'), 'utf8');
  for (const [, , words] of REFUSALS) expect(server).toContain(`'${words}'`);
});

test('a calibration row shows status, the server’s gate words and percentages only, never a guest count', async () => {
  const guests = { guests: SENTINEL, mid: SENTINEL };
  const summary = { ...(calibration().summary as Record<string, unknown>), ...guests };
  await show({ calibrations: [calibration({ ...guests, summary }), calibration({ id: 'c2', status: 'failed', failure: 'timeout', failureWords: 'It took too long and was stopped.', gate: null, summary: null, via: 'chat', requestedByRole: 'org_admin' })] });
  expect(screen.getByText('Done')).toBeTruthy();
  expect(screen.getByText('Started by Townwise staff')).toBeTruthy();
  expect(screen.getByText('Weekly error 8.4% vs 10.1% for the current forecast, on 12 held-out weeks.')).toBeTruthy();
  expect(screen.getByText('80% range held 10 of 12 weeks.')).toBeTruthy();
  expect(screen.getByText('Weekday bias 3.2%.')).toBeTruthy();
  expect(screen.getByText('It beat the current forecast on every check, so it was published.')).toBeTruthy();
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(screen.getByText('It took too long and was stopped.')).toBeTruthy();
  expect(screen.getByText('Started by an org admin in TownwiseAI')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/98,?765/);
});

test('a calibration staff started in TownwiseAI while open as admin reads as staff’s (D25)', async () => {
  await show({ calibrations: [calibration({ via: 'chat', requestedByRole: 'superadmin' })] });
  expect(screen.getByText('Started by Townwise staff in TownwiseAI')).toBeTruthy();
  expect(screen.queryByText('Started by an org admin in TownwiseAI')).toBeNull();
});

test('a summary with nothing to compare reads without the current forecast', async () => {
  await show({ calibrations: [calibration({ summary: { weeks: 12, weeklyWapePct: 8.4, championWeeklyWapePct: null, coverage: { inside: 10, weeks: 12 }, weekdayBiasPct: 3.2, championWeekdayBiasPct: null } })] });
  expect(screen.getByText('Weekly error 8.4% on 12 held-out weeks.')).toBeTruthy();
});

test.each([
  [new ApiError('http', 'The request was refused.', { status: 409, code: 'calibration_in_progress' }), 'A calibration for this location is already running.'],
  [new ApiError('http', 'The request was refused.', { status: 429, code: 'calibrations_rate_limited' }), 'This organization has started 4 calibrations in the last day. Try again tomorrow.'],
])('a refusal shows the server message in the dialog', async (error, text) => {
  const api = await show();
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Calibrate Hanover' })); });
  api.routes[START] = () => error;
  const dialog = screen.getByRole('dialog', { name: 'Calibrate Hanover?' });
  await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Calibrate' })); });
  expect(within(dialog).getByText(text)).toBeTruthy();
});

test('the runs table shows Source: Imported or Calibration', async () => {
  await show({ runs: [run(), run({ id: 'run2', trainingSource: 'townwise_lab' })] });
  const table = screen.getByRole('region', { name: 'Forecasts for Hanover' });
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toContain('Source');
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((row) => within(row).getAllByRole('cell')[5]?.textContent)).toEqual(['Imported', 'Calibration']);
});
