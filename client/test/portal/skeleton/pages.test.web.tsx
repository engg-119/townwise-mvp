import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { LAST_YEAR_FOOTNOTE } from '../../../src/portal/analytics/week';
import { cellSize } from '../../../src/portal/calendar/grid';
import { FOLDERS } from '../../../src/portal/data/folders';
import { AnalyticsSkeleton } from '../../../src/portal/skeleton';
import { readingLine, sendingLine } from '../../../src/portal/upload/copy';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, type FakePortalApi } from '../../helpers/portal';
import { choose } from '../../helpers/select';
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

describe('P26 Your data', () => {
  afterEach(() => { window.localStorage.clear(); });

  /** An org admin of two locations, whose list reads (one location's or every location's) never answer. */
  function hangData(): FakePortalApi {
    return hang(hang(fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }), '/api/org/data?locationId=l1'), '/api/org/data');
  }

  /** The columns of a skeleton table: the cells of its head row (SkeletonTable: clip, width, head row). */
  function columnsOf(table: HTMLElement): number {
    return table.firstElementChild?.firstElementChild?.firstElementChild?.children.length ?? 0;
  }

  test('Organized, the default: a row for each folder under the page’s actions, and no table', async () => {
    renderPage('/locations/l1/data', hangData());
    await expectSkeleton('data', 'Loading your data');
    expect(screen.getAllByTestId('skeleton-data-folder')).toHaveLength(FOLDERS.length);
    expect(screen.queryByTestId('skeleton-data-table')).toBeNull();
  });

  test('Newest first: the table with the list’s columns, the Location column under All locations', async () => {
    window.localStorage.setItem(`townwise.dataView.${meOf(ACCESS.admin).user.id}`, 'newest');
    renderPage('/locations/l1/data', hangData());
    await expectSkeleton('data', 'Loading your data');
    expect(screen.queryByTestId('skeleton-data-folder')).toBeNull();
    expect(columnsOf(screen.getByTestId('skeleton-data-table'))).toBe(6);
    choose(screen.getByRole('combobox', { name: 'Show' }), 'All locations');
    expect(columnsOf(await screen.findByTestId('skeleton-data-table'))).toBe(7);
  });
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

  test('P28 Calendar: the toolbar, a six-week grid of 42 cells and the day panel', async () => {
    renderPage('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    expect(screen.getAllByTestId('skeleton-calendar-cell')).toHaveLength(42);
    expect(screen.getAllByTestId('skeleton-calendar-panel')).toHaveLength(1);
  });

  test('P28 Calendar at 1280: cells as tall as the loaded grid’s, the filters heading its column and the panel beside them', async () => {
    renderPage('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    const cells = screen.getAllByTestId('skeleton-calendar-cell');
    expect(new Set(cells.map((cell) => window.getComputedStyle(cell).height))).toEqual(new Set([`${String(cellSize(1280).height)}px`]));
    const filters = screen.getByTestId('skeleton-calendar-filters');
    const first = cells[0];
    if (first === undefined) throw new Error('no cells');
    const column = filters.parentElement;
    expect(column?.contains(first)).toBe(true);
    expect(filters.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const panel = screen.getByTestId('skeleton-calendar-panel');
    expect(column?.contains(panel)).toBe(false);
    expect(column?.parentElement?.contains(panel)).toBe(true);
    // The header row: a 216px label block between the arrows and the view switch's block.
    expect(window.getComputedStyle(screen.getByTestId('skeleton-calendar-label')).width).toBe('216px');
  });

  test('P28 Calendar: after the label the header row holds the view switch’s 130px block and the Your calendars button’s 170px block, the row’s last item', async () => {
    renderPage('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    const label = screen.getByTestId('skeleton-calendar-label');
    const views = screen.getByTestId('skeleton-calendar-views');
    const block = views.firstElementChild;
    expect(block === null ? null : window.getComputedStyle(block).width).toBe('130px');
    expect(label.compareDocumentPosition(views) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each a header row item of its own, as the switch and "Your calendars" are in the page's row, at about their
    // widths, so the skeleton wraps where the page does (one line at 1024, two at 375). The panel is closed on load, so
    // nothing stands for it.
    const row = label.parentElement?.parentElement;
    expect(views.parentElement).toBe(row);
    const calendars = screen.getByTestId('skeleton-calendar-calendars');
    expect(views.nextElementSibling).toBe(calendars);
    expect(window.getComputedStyle(calendars).width).toBe('170px');
    expect(calendars.childElementCount).toBe(0);
    expect(calendars.nextElementSibling).toBeNull();
    // As tall as the controls they stand for: 44px each.
    for (const item of [block, calendars]) expect(item === null ? null : window.getComputedStyle(item).minHeight).toBe('44px');
  });

  test('P28 Calendar at 375: the filters come after the month, and the label block is not fixed', async () => {
    setWidth(375);
    renderPage('/locations/l1/calendar', hangLocal());
    await expectSkeleton('calendar', 'Loading the calendar');
    const cells = screen.getAllByTestId('skeleton-calendar-cell');
    expect(new Set(cells.map((cell) => window.getComputedStyle(cell).height))).toEqual(new Set(['52px']));
    const filters = screen.getByTestId('skeleton-calendar-filters');
    const last = cells.at(-1);
    if (last === undefined) throw new Error('no cells');
    expect(last.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filters.compareDocumentPosition(screen.getByTestId('skeleton-calendar-panel')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(window.getComputedStyle(screen.getByTestId('skeleton-calendar-label')).width).not.toBe('216px');
  });

  // As MonthGrid.web.tsx draws a narrow cell: at least 64px from 641px, 52px on phones (a wide one is 96px).
  test('P11 Home: its month cells are the grid’s 64px from 641px, 52px at 375', async () => {
    renderPage('/locations/l1', hangLocal());
    await screen.findByTestId('skeleton-home');
    const heights = (): Set<string> => new Set(screen.getAllByTestId('skeleton-home-month-cell').map((cell) => window.getComputedStyle(cell).height));
    expect(heights()).toEqual(new Set(['64px']));
    cleanup();
    setWidth(375);
    renderPage('/locations/l1', hangLocal());
    await screen.findByTestId('skeleton-home');
    expect(heights()).toEqual(new Set(['52px']));
  });

  test('P11 Home: it reaches the page’s last block, Your history, with its heatmap', async () => {
    renderPage('/locations/l1', hangLocal());
    const skeleton = await screen.findByTestId('skeleton-home');
    expect(within(skeleton).getByTestId('skeleton-home-heatmap')).toBeTruthy();
  });

  // Its invisible words (SkeletonWords) are the page's fixed copy or masked placeholders: find in page and copy never
  // meet a made-up figure or a forecast the page hasn't made.
  test('P11 Home: its words hold no figure and no forecast wording', async () => {
    renderPage('/locations/l1', hangLocal());
    const skeleton = await screen.findByTestId('skeleton-home');
    const status = within(skeleton).getByRole('status').textContent;
    // The one fixed line with figures is true copy the page shows as it is (52 weeks, 4 weeks).
    const words = skeleton.textContent.replace(status, '').replace(LAST_YEAR_FOOTNOTE, '');
    expect(words).not.toMatch(/\d/);
    expect(words).not.toMatch(/\blikely\b|\bforecast\b|\bguests\b/i);
  });

  test('P29 Business rules: the add form and a few rows', async () => {
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
  test('P32 Overview: the tiles, Needs attention, the chart and the table’s skeleton, under the window switch', async () => {
    const api = consoleApi();
    api.routes['GET /api/admin/overview?days=28'] = never;
    renderConsole('/admin/overview', api);
    await expectSkeleton('overview', 'Loading the overview');
    expect(screen.getByRole('navigation', { name: 'Window' })).toBeTruthy();
  });

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
