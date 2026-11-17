import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { ForecastRuns } from '../../../src/portal/console/ForecastRuns';
import { staffMe } from '../../helpers/portal';
import { portalWrapper } from '../files/harness';
import { consoleApi, orgDetail, type ConsoleApi } from './helpers';

// The forecasts switch (G1) since D42: forecasts are on by default, so an organization nobody switched (on, no date)
// shows "On (default)" with Switch off; switching off and back on works as before, the way back on still needing the
// owner's agreement. Synthetic data.

afterEach(() => {
  cleanup();
});

const CALS = 'GET /api/admin/orgs/o1/calibrations';
const SWITCH = 'POST /api/admin/orgs/o1/forecasts-switch';
const DETAIL = orgDetail();
const ORG = DETAIL.org.name;

async function show(forecasts: { on: boolean; at: string | null }): Promise<ConsoleApi> {
  const api = consoleApi();
  api.routes['GET /api/admin/orgs/o1/forecast-runs'] = () => ({ runs: [] });
  api.routes[CALS] = () => ({ forecasts, calibrations: [] });
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

test('an organization nobody switched shows On (default) and Switch off', async () => {
  await show({ on: true, at: null });
  expect(screen.getByText(`On (default). Forecasts are on for ${ORG}, as for every organization Townwise staff haven’t switched off.`)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Switch off' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Switch on' })).toBeNull();
});

test('switching a default organization off posts on false and then shows it off', async () => {
  const api = await show({ on: true, at: null });
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Switch off' })); });
  api.routes[SWITCH] = () => ({ forecasts: { on: false, at: '2026-11-23T12:00:00.000Z' } });
  api.routes[CALS] = () => ({ forecasts: { on: false, at: '2026-11-23T12:00:00.000Z' }, calibrations: [] });
  await settle(() => { fireEvent.click(within(screen.getByRole('dialog', { name: `Switch off forecasts for ${ORG}?` })).getByRole('button', { name: 'Switch off' })); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/admin/orgs/o1/forecasts-switch', body: { on: false } }]);
  expect(await screen.findByText(`Forecasts are off for ${ORG}. Nothing is published, by you or by a calibration, until they’re on.`)).toBeTruthy();
  expect(screen.queryByText(/On \(default\)/)).toBeNull();
});

test('switched on by staff shows the date, not the default', async () => {
  await show({ on: true, at: '2026-11-03T12:00:00.000Z' });
  expect(screen.getByText(`Forecasts are on for ${ORG} since Nov 3, 2026.`)).toBeTruthy();
  expect(screen.queryByText(/On \(default\)/)).toBeNull();
});
