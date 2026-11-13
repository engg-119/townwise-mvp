import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AnalyticsSkeleton } from '../../../src/portal/skeleton';
import { readingLine, sendingLine } from '../../../src/portal/upload/copy';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, type FakePortalApi } from '../../helpers/portal';
import { locationsFake } from '../locations/fakes';
import { consoleApi, renderAt as renderConsole, setWidth } from '../console/helpers';

// Each page's loading state in the browser (spec 15.7 Loading, 16.3, 16.4): Your data, Upload while it reads and
// while it sends, and the staff console's pages show their skeleton, holding the page's loading words as its one
// status line, in place of the old text line.

afterEach(() => {
  cleanup();
  setWidth(1280);
});

const never = (): Promise<never> => new Promise(() => undefined);

/** Reads of `path` never answer, so the page stays loading. */
function hang(api: FakePortalApi, path: string): FakePortalApi {
  const json = api.json.bind(api);
  api.json = (at, schema, opts) => ((opts?.method ?? 'GET') === 'GET' && at === path ? never() : json(at, schema, opts));
  return api;
}

/** Every read under the location never answers, so a page that waits for several reads stays loading. */
function hangLocation(api: FakePortalApi): FakePortalApi {
  const json = api.json.bind(api);
  api.json = (at, schema, opts) => ((opts?.method ?? 'GET') === 'GET' && at.startsWith('/api/org/locations/l1/') ? new Promise(() => undefined) : json(at, schema, opts));
  return api;
}

function renderPage(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

/** The page's skeleton holds the loading words, and they show nowhere else. */
async function expectSkeleton(name: string, words: string): Promise<void> {
  const skeleton = await screen.findByTestId(`skeleton-${name}`);
  expect(within(skeleton).getByRole('status').textContent).toBe(words);
  expect(screen.getAllByText(words)).toHaveLength(1);
  expect(within(skeleton).getByTestId('skeleton-shapes').getAttribute('aria-hidden')).toBe('true');
}

test('P26 Your data: the table’s skeleton under the page’s actions', async () => {
  const api = hang(fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), '/api/org/data?locationId=l1');
  renderPage('/locations/l1/data', api);
  await expectSkeleton('data', 'Loading your data');
});

describe('the location pages', () => {
  const hangLocal = (): FakePortalApi => hangLocation(fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: locationsFake() }));

  test('P11 Home: the lead, the figures, the month grid and Who’s in town', async () => {
    renderPage('/locations/l1', hangLocal());
    const skeleton = await screen.findByTestId('skeleton-home');
    expect(within(skeleton).getByRole('status').textContent).toMatch(/^Loading \S/);
    expect(screen.getAllByText(within(skeleton).getByRole('status').textContent)).toHaveLength(1);
    expect(within(skeleton).getAllByTestId('skeleton-home-month-cell')).toHaveLength(42);
  });

  test('P27 Calendar: the toolbar, a six-week grid of 42 cells and the day panel', async () => {
    renderPage('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    expect(screen.getAllByTestId('skeleton-calendar-cell')).toHaveLength(42);
    expect(screen.getAllByTestId('skeleton-calendar-panel')).toHaveLength(1);
  });

  test('P28 Business rules: the add form and a few rows', async () => {
    renderPage('/locations/l1/rules', hangLocal());
    await expectSkeleton('rules', 'Loading business rules');
    expect(screen.getAllByTestId('skeleton-rules-row').length).toBeGreaterThanOrEqual(3);
    // Change the forecast is the page's outline button (a 1px line, 44px tall), not a text link, over its helper line.
    const button = screen.getByTestId('skeleton-rules-schedule-button').firstElementChild;
    if (button === null) throw new Error('no button shape');
    expect(window.getComputedStyle(button).borderTopWidth).toBe('1px');
    expect(window.getComputedStyle(button).minHeight).toBe('44px');
    expect(screen.getByTestId('skeleton-rules-schedule-help')).toBeTruthy();
  });
});

// The skeleton is checked alone here; Analytics.tsx mounts it while loading.
describe('P24 Analytics', () => {
  test('the lead, the filter block, Every day’s heatmap with the Day panel beside it, and the chart sections', async () => {
    render(<AnalyticsSkeleton label="Loading analytics" />);
    await expectSkeleton('analytics', 'Loading analytics');
    // Color by's two switches and the three groups of boxes (Show on the calendar, Include in the numbers, Years).
    const filters = screen.getByTestId('skeleton-analytics-filters');
    expect(within(filters).getAllByTestId('skeleton-analytics-filter-group')).toHaveLength(4);
    expect(window.getComputedStyle(filters).flexDirection).toBe('row');
    // From 1024px the panel sits beside the heatmap, not under it.
    const heatmap = screen.getByTestId('skeleton-analytics-heatmap');
    const panel = screen.getByTestId('skeleton-analytics-panel');
    expect(heatmap.contains(panel)).toBe(false);
    expect(heatmap.parentElement?.contains(panel)).toBe(false);
    // Weekly shape, By month and Year over year are 160px charts; By type of night is bars; Biggest drivers a table.
    expect(screen.getAllByTestId('skeleton-analytics-chart')).toHaveLength(3);
    expect(screen.getAllByTestId('skeleton-analytics-bars')).toHaveLength(1);
    expect(screen.getAllByTestId('skeleton-analytics-drivers')).toHaveLength(1);
  });

  test('at phone width the filters stack and the Day panel follows the heatmap', async () => {
    setWidth(375);
    render(<AnalyticsSkeleton label="Loading analytics" />);
    await expectSkeleton('analytics', 'Loading analytics');
    expect(window.getComputedStyle(screen.getByTestId('skeleton-analytics-filters')).flexDirection).toBe('column');
    const heatmap = screen.getByTestId('skeleton-analytics-heatmap');
    const panel = screen.getByTestId('skeleton-analytics-panel');
    expect(heatmap.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heatmap.parentElement?.contains(panel)).toBe(true);
  });
});

describe('P13 Upload', () => {
  const FILE = 'Date,Guests,Net Sales\n2025-03-04,120,1000.00\n2025-03-05,90,980.00';

  function csvFile(text: () => Promise<string>): File {
    const file = new File([FILE], 'export.csv', { type: 'text/csv' });
    // jsdom's Blob has no text(); the page reads files with File.text() (spec 11.1).
    Object.defineProperty(file, 'text', { value: text });
    return file;
  }

  async function settle(fire: () => void): Promise<void> {
    await act(async () => {
      fire();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
  }

  async function choose(file: File): Promise<void> {
    await screen.findByRole('heading', { name: 'Choose a file' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    await settle(() => { fireEvent.change(input, { target: { files: [file] } }); });
  }

  test('while the file is read: the Match columns skeleton, with “Reading {size} file…”', async () => {
    renderPage('/locations/l1/sales/upload', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    const file = csvFile(never);
    await choose(file);
    await expectSkeleton('upload-reading', readingLine(file.size));
  });

  test('while the days are sent: the result’s skeleton, with “Sending {days} days…”', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
    api.answers['/api/org/locations/l1/sales/uploads'] = never;
    renderPage('/locations/l1/sales/upload', api);
    await choose(csvFile(() => Promise.resolve(FILE)));
    await screen.findByRole('heading', { name: 'Match columns' });
    await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Check the totals' })); });
    await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'Send 2 days' })); });
    await expectSkeleton('upload-sending', sendingLine(2));
  });
});

describe('the staff console', () => {
  test('P19 Requests: the table and the request panel’s skeleton', async () => {
    const api = consoleApi();
    api.routes['GET /api/admin/requests?status=pending'] = never;
    renderConsole('/admin', api);
    await expectSkeleton('requests', 'Loading requests');
  });

  test('P20 Organizations: the filters and the table’s skeleton', async () => {
    const api = consoleApi();
    api.routes['GET /api/admin/orgs'] = never;
    renderConsole('/admin/orgs', api);
    await expectSkeleton('orgs', 'Loading organizations');
  });

  test('P21 Organization: its sections’ skeleton', async () => {
    const api = consoleApi();
    api.routes['GET /api/admin/orgs/o1'] = never;
    renderConsole('/admin/orgs/o1', api);
    await expectSkeleton('org', 'Loading the organization');
  });

  test('P22 People: the table’s skeleton under the filters and the lookup', async () => {
    const api = consoleApi();
    api.routes['GET /api/admin/people'] = never;
    renderConsole('/admin/people', api);
    await expectSkeleton('people', 'Loading people');
    expect(screen.getByRole('heading', { name: 'Find a signed-in person by exact email' })).toBeTruthy();
  });

  test('P23 Audit log: the events’ skeleton under the filters', async () => {
    const api = consoleApi();
    api.routes['GET /api/admin/orgs'] = () => ({ orgs: [] });
    api.routes['GET /api/admin/audit'] = never;
    renderConsole('/admin/audit', api);
    await expectSkeleton('audit', 'Loading the audit log');
    expect(screen.getByRole('region', { name: 'Filters' })).toBeTruthy();
  });
});
