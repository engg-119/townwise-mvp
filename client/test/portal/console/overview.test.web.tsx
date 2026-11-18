import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { formatDate } from '../../../src/portal/format';
import { ACCESS, deferred, meOf, offline, refusal } from '../../helpers/portal';
import { consoleApi, overviewAnswer, overviewOrg, renderAt, setWidth, type ConsoleApi } from './helpers';

// P32 Overview (/admin/overview, staff): openspec change staff-overview, design decision 7 and the staff-overview spec.

afterEach(() => {
  cleanup();
  setWidth(1280);
});

function answer(api: ConsoleApi, days: number, body: unknown): void {
  api.routes[`GET /api/admin/overview?days=${String(days)}`] = () => body;
}

function gets(api: ConsoleApi, path: string): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === path).length;
}

/** Each tile's text, by its label. */
function tile(label: string): string {
  const eyebrow = screen.getByText(label, { selector: '*' });
  return eyebrow.parentElement?.textContent ?? '';
}

function rows(region: HTMLElement): string[][] {
  return within(region).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
}

test('the tiles with their figures and their change in words, Overview current in the nav, 28 days with no query', async () => {
  const api = consoleApi();
  answer(api, 28, overviewAnswer(28));
  renderAt('/admin/overview', api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  await screen.findByText('Active organizations');
  expect(gets(api, '/api/admin/overview?days=28')).toBe(1);
  expect(tile('Active organizations')).toBe('Active organizations4of 6Up 1 from the 28 days before');
  expect(tile('Active people')).toBe('Active people9of 14Up 3 from the 28 days before');
  expect(tile('TownwiseAI turns')).toBe('TownwiseAI turns12Same as the 28 days before');
  expect(tile('Sales uploads')).toBe('Sales uploads3Down 2 from the 28 days before');
  expect(tile('Notes written')).toBe('Notes written7Up 5 from the 28 days before');
  expect(tile('Order decisions')).toBe('Order decisions1Up 1 from the 28 days before');
  expect(screen.getByText('Active days recorded since Jun 1, 2026. Days are UTC.')).toBeTruthy();

  const nav = screen.getByRole('navigation', { name: 'Main' });
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Requests 2', 'Organizations', 'People', 'Audit log']);
  expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
  const tabs = screen.getByRole('navigation', { name: 'Window' });
  expect(within(tabs).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
    ['7 days', '/admin/overview?days=7', null], ['28 days', '/admin/overview?days=28', 'page'], ['90 days', '/admin/overview?days=90', null],
  ]);
});

test('with nothing recorded yet, the page says so plainly and each activity figure has no earlier days', async () => {
  const api = consoleApi();
  answer(api, 7, overviewAnswer(7, {
    recordingSince: null,
    totals: {
      activeOrgs: { count: 0, previous: null, of: 2 }, activePeople: { count: 0, previous: null, of: 5 },
      chatTurns: { count: 0, previous: 0 }, salesUploads: { count: 1, previous: 0 }, notesWritten: { count: 0, previous: 0 }, orderDecisions: { count: 0, previous: 0 },
    },
  }));
  renderAt('/admin/overview?days=7', api);
  expect(await screen.findByText(/^No activity is recorded yet\. Active people and organizations count from the first day/)).toBeTruthy();
  expect(tile('Active people')).toBe('Active people0of 5No earlier days recorded');
  expect(tile('Active organizations')).toBe('Active organizations0of 2No earlier days recorded');
  expect(tile('Sales uploads')).toBe('Sales uploads1Up 1 from the 7 days before');
});

test('Needs attention: each item in words with its link, and “Nothing needs attention.” when empty', async () => {
  const api = consoleApi();
  const since = '2026-11-12T15:00:00.000Z';
  answer(api, 28, overviewAnswer(28, {
    attention: [
      { kind: 'request_waiting', orgId: null, requestId: 'r1', count: null, since },
      { kind: 'no_recent_upload', orgId: 'o2', requestId: null, count: null, since },
      { kind: 'invites_waiting', orgId: 'o1', requestId: null, count: 2, since },
    ],
  }));
  answer(api, 7, overviewAnswer(7));
  renderAt('/admin/overview', api);
  const list = await screen.findByRole('list', { name: 'Needs attention' });
  const items = within(list).getAllByRole('listitem');
  expect(items.map((item) => item.textContent)).toEqual([
    `An access request has waited since ${formatDate(since)}.Open the request`,
    `Sample Campus Pub has had no upload since ${formatDate(since)}.Open Sample Campus Pub`,
    `2 invitations to Sample Mountain Tavern are unanswered, the oldest since ${formatDate(since)}.Open Sample Mountain Tavern`,
  ]);
  expect(within(list).getByRole('link', { name: 'Open the request' }).getAttribute('href')).toBe('/admin?request=r1');
  expect(within(list).getByRole('link', { name: 'Open Sample Campus Pub' }).getAttribute('href')).toBe('/admin/orgs/o2');

  fireEvent.click(within(screen.getByRole('navigation', { name: 'Window' })).getByRole('link', { name: '7 days' }));
  expect(await screen.findByText('Nothing needs attention.')).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Needs attention' })).toBeNull();
});

/** The line under the window tabs, in its kept slot. */
function windowLine(): HTMLElement {
  return screen.getByTestId('overview-window');
}

function figures(): HTMLElement {
  return screen.getByTestId('overview-figures');
}

test('a window change keeps the last answer on screen, dimmed and inert under a line that says what loads, with no skeleton', async () => {
  const api = consoleApi();
  answer(api, 28, overviewAnswer(28));
  const next = deferred<unknown>();
  api.routes['GET /api/admin/overview?days=90'] = () => next.promise;
  renderAt('/admin/overview', api);
  await screen.findByText('Active people');
  expect(screen.queryByTestId('skeleton-overview')).toBeNull();
  expect(within(windowLine()).getByRole('status').textContent).toBe('The last 28 days, Oct 21, 2026 to Nov 17, 2026 (UTC).');
  // The slot's height is kept whatever it says, so nothing under it moves when it changes.
  expect(getComputedStyle(windowLine()).minHeight).toBe('20px');
  expect(figures().getAttribute('aria-busy')).not.toBe('true');
  expect(figures().hasAttribute('inert')).toBe(false);

  const tabs = screen.getByRole('navigation', { name: 'Window' });
  fireEvent.click(within(tabs).getByRole('link', { name: '90 days' }));
  await waitFor(() => { expect(gets(api, '/api/admin/overview?days=90')).toBe(1); });
  // The 28-day figures stay, dimmed and inert, the line says what is loading and what is still shown, the tabs say
  // where the page is going, and the skeleton never shows.
  expect(tile('Active people')).toBe('Active people9of 14Up 3 from the 28 days before');
  expect(screen.queryByTestId('skeleton-overview')).toBeNull();
  expect(within(tabs).getByRole('link', { name: '90 days' }).getAttribute('aria-current')).toBe('page');
  expect(within(windowLine()).getByRole('status').textContent).toBe('Loading the last 90 days… Below: the last 28 days until then.');
  expect(figures().getAttribute('aria-busy')).toBe('true');
  expect(figures().hasAttribute('inert')).toBe(true);
  expect(getComputedStyle(figures()).opacity).toBe('0.6');
  expect(getComputedStyle(windowLine()).minHeight).toBe('20px');

  await act(async () => {
    next.resolve(overviewAnswer(90, { totals: { ...overviewAnswer(90).totals as object, activePeople: { count: 11, previous: null, of: 14 } } }));
    await next.promise;
  });
  await waitFor(() => { expect(tile('Active people')).toBe('Active people11of 14No earlier days recorded'); });
  expect(tile('Sales uploads')).toBe('Sales uploads3Down 2 from the 90 days before');
  expect(within(windowLine()).getByRole('status').textContent).toBe('The last 90 days, Aug 20, 2026 to Nov 17, 2026 (UTC).');
  expect(figures().hasAttribute('inert')).toBe(false);
});

test('a failed change shows the error in place of the old figures, and Try again moves focus to the loading line', async () => {
  const api = consoleApi();
  answer(api, 28, overviewAnswer(28));
  api.routes['GET /api/admin/overview?days=90'] = () => offline();
  renderAt('/admin/overview', api);
  await screen.findByText('Active people');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Window' })).getByRole('link', { name: '90 days' }));
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  // No 28-day figure stays under the 90-day tab as if it were current.
  expect(screen.queryByText('Active people')).toBeNull();
  expect(screen.queryByTestId('overview-figures')).toBeNull();

  const next = deferred<unknown>();
  api.routes['GET /api/admin/overview?days=90'] = () => next.promise;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(within(windowLine()).getByRole('status').textContent).toBe('Loading the last 90 days… Below: the last 28 days until then.');
  expect(document.activeElement).toBe(windowLine());
  expect(figures().hasAttribute('inert')).toBe(true);
  await act(async () => { next.resolve(overviewAnswer(90)); await next.promise; });
  await waitFor(() => { expect(within(windowLine()).getByRole('status').textContent).toBe('The last 90 days, Aug 20, 2026 to Nov 17, 2026 (UTC).'); });
  expect(document.activeElement).toBe(windowLine());
});

test('the skeleton shows only before the first answer; a failed read shows the error with Try again', async () => {
  const api = consoleApi();
  const first = deferred<unknown>();
  api.routes['GET /api/admin/overview?days=28'] = () => first.promise;
  renderAt('/admin/overview', api);
  const skeleton = await screen.findByTestId('skeleton-overview');
  expect(within(skeleton).getByRole('status').textContent).toBe('Loading the overview');
  expect(windowLine().textContent).toBe('Loading the last 28 days…');
  await act(async () => { first.resolve(offline()); await first.promise; });
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  expect(screen.queryByTestId('skeleton-overview')).toBeNull();
  answer(api, 28, overviewAnswer(28));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  // The button went with the error, so focus moves to the line that says what is loading, not to the page body.
  expect(document.activeElement).toBe(windowLine());
  expect(await screen.findByText('Active people')).toBeTruthy();
  expect(gets(api, '/api/admin/overview?days=28')).toBe(2);
});

test('a member who opens the page is sent to their own home, and the page is never read', async () => {
  const api = consoleApi(meOf(ACCESS.member));
  answer(api, 28, refusal(403, 'forbidden'));
  renderAt('/admin/overview', api);
  await waitFor(() => { expect(window.location.pathname).toBe('/dashboard'); });
  expect(gets(api, '/api/admin/overview?days=28')).toBe(0);
});

test('the organizations: each row opens its page, with its usage, forecast lines, weekly refresh and TownwiseAI spend', async () => {
  const api = consoleApi();
  answer(api, 28, overviewAnswer(28, {
    orgs: [
      overviewOrg('o1', 'Sample Mountain Tavern', {
        locations: [
          {
            id: 'l1', name: 'Hanover', newestRun: { dataThrough: '2026-11-08', madeAt: '2026-11-09T08:00:00.000Z', engine: 'model' },
            accuracy: { days: 21, inRange: 17, typicalErrorPct: 12.4 }, refresh: { week: '2026-11-16', outcome: 'start_failed' }, lastScheduled: 'failed',
          },
          { id: 'l2', name: 'Lebanon', newestRun: null, accuracy: null, refresh: null, lastScheduled: null },
        ],
      }),
      overviewOrg('o2', 'Sample Campus Pub', {
        status: 'suspended', inSetup: false, lastActiveDay: null, lastUploadAt: null, forecastsOn: false, activePeople: 0, actions: 0,
        chat: { spentMicroUsd: 0, budgetMicroUsd: 0 },
      }),
      overviewOrg('o3', 'Sample Inn', { inSetup: true, locations: [] }),
    ],
  }));
  renderAt('/admin/overview', api);
  const table = await screen.findByRole('region', { name: 'Organizations' });
  expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
    'Organization', 'Status', 'Last active', 'People active', 'Actions', 'Days of sales', 'Last upload', 'Forecast on these days', 'Weekly refresh',
    'TownwiseAI this month',
  ]);
  const made = formatDate('2026-11-09T08:00:00.000Z');
  const uploaded = formatDate('2026-11-10T15:00:00.000Z');
  expect(rows(table)).toEqual([
    [
      'Sample Mountain Tavern', 'Active', 'Nov 16, 2026', '2', '14', '400', uploaded,
      `Hanover: Newest run used: made ${made}, model, data through Nov 8, 2026. Typical error 12.4% over 21 days, 17 in rangeLebanon: No published forecast on these days`,
      'Hanover: Week of Nov 16, 2026: couldn’t start; the last scheduled calibration failedLebanon: No weekly refresh yet',
      '$4.10 of $20',
    ],
    ['Sample Campus Pub', 'Suspended', 'None recorded', '0', '0', '400', 'None yet', 'Forecasts off', 'Week of Nov 16, 2026: started', '$0, no budget'],
    ['Sample Inn', 'Active, in setup', 'Nov 16, 2026', '2', '14', '400', uploaded, 'No locations', '', '$4.10 of $20'],
  ]);
  expect(within(table).getByRole('link', { name: 'Sample Campus Pub' }).getAttribute('href')).toBe('/admin/orgs/o2');
  fireEvent.click(within(table).getByRole('link', { name: 'Sample Inn' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin/orgs/o3'); });
});

test('activity by day: the chart hidden from screen readers, its summary, and each day’s numbers on request', async () => {
  const api = consoleApi();
  answer(api, 7, overviewAnswer(7));
  renderAt('/admin/overview?days=7', api);
  expect(await screen.findByRole('heading', { name: 'Activity by day' })).toBeTruthy();
  const svg = document.querySelector('svg[data-chart="activity"]');
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect(svg?.querySelectorAll('[data-band="people"]')).toHaveLength(2);
  expect([...(svg?.querySelectorAll('[data-day="2026-11-16"] [data-group]') ?? [])].map((rect) => rect.getAttribute('data-group'))).toEqual(['notes', 'orders', 'team']);
  expect(screen.getByText(/^9 actions recorded in the last 7 days \(UTC\): 2 Uploads and data, 4 Notes, rules and calendars/)).toBeTruthy();

  // A mouse over a day shows its counts (jsdom lays nothing out, so the svg gets a 280px box: seven 40px days).
  const box = svg as SVGSVGElement;
  box.getBoundingClientRect = () => ({ left: 0, width: 280, top: 0, height: 204, right: 280, bottom: 204, x: 0, y: 0, toJSON: () => ({}) });
  const move = new MouseEvent('pointermove', { bubbles: true, clientX: 220 });
  Object.defineProperty(move, 'pointerType', { value: 'mouse' });
  fireEvent(box, move);
  expect(Array.from(screen.getByTestId('chart-tooltip').children, (line) => line.textContent)).toEqual([
    'Nov 16, 2026', '5 people active', '6 actions recorded', 'Notes, rules and calendars: 4', 'Orders: 1', 'Team and settings: 1',
  ]);
  fireEvent.pointerLeave(box);
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();

  const show = screen.getByRole('button', { name: 'Show each day' });
  expect(show.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(show);
  const days = await screen.findByRole('region', { name: 'Activity by day' });
  expect(screen.getByRole('button', { name: 'Hide each day' }).getAttribute('aria-controls')).toBe('overview-each-day');
  const [newest, before] = rows(days);
  expect(newest).toEqual(['Nov 17, 2026', '3', '3', '2', '0', '1', '0', '0']);
  expect(before).toEqual(['Nov 16, 2026', '5', '6', '0', '4', '0', '1', '1']);
  expect(rows(days)).toHaveLength(7);
});

test('the console’s wordmark opens Overview, and Requests stays at /admin', async () => {
  const api = consoleApi();
  answer(api, 28, overviewAnswer(28));
  renderAt('/admin/overview', api);
  await screen.findByText('Active people');
  expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Townwise' }).getAttribute('href')).toBe('/admin/overview');
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: /^Requests/ }).getAttribute('href')).toBe('/admin');
});
