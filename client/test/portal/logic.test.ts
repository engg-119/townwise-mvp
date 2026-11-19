import { ApiError } from '../../src/api/client';
import { mapTowns } from '../../src/marketing/map/mapState';
import { errorCopy, needsRecheck, tooManyAttempts } from '../../src/portal/errors';
import { formatCount, formatDate, formatTime, plural } from '../../src/portal/format';
import {
  calendarHref, clientNav, consoleNav, HOME, homeFor, isAllowed, isFillRoute, itemHref, locationHref, navLocationId, pageTitle, tabOf,
  type TabKey,
} from '../../src/portal/routing';
import { calibrationSchema, meResponseSchema, orgResponseSchema, type Access } from '../../src/portal/schemas';
import {
  dateRange, patternOf, TOWN_GROUPS, townProfile, townResearchLine,
} from '../../src/portal/towns';
import { checkTown } from '../../src/portal/ui/TownFields';
import { ACCESS, meOf, openAsAdminMe, orgOf, refusal, staffMe, viewAsMe } from '../helpers/portal';

const ALL: [string, Access][] = Object.entries(ACCESS);

const GATE = ['/request-access', '/waiting', '/no-access', '/joining'];
/** An upload's and a stored file's item page (P27). */
const UPLOAD_ITEM = '/locations/l1/data/u_0123456789abcdef01234567';
const FILE_ITEM = '/locations/l1/data/f_89abcdef0123456789abcdef';
/** A calendar's page (D49): a client-only ref on P27's route. */
const CALENDAR_ITEM = '/locations/l1/data/c_fedcba9876543210fedcba98';
const MEMBER = [
  '/dashboard', '/settings', '/locations/l1', '/locations/l1/calendar', '/locations/l1/analytics', '/locations/l1/sales', '/locations/l1/sales/upload',
  '/locations/l1/data', UPLOAD_ITEM, FILE_ITEM, CALENDAR_ITEM, '/locations/l1/notes', '/locations/l1/town', '/locations/l1/orders', '/locations/l1/orders/setup',
  '/locations/l1/agent', '/locations/l1/agent/changes', '/locations/l1/chat', '/locations/l1/rules',
];
const ADMIN_ONLY = ['/team', '/locations/new', '/locations/l1/settings'];
const CONSOLE = ['/admin/overview', '/admin', '/admin/orgs', '/admin/orgs/o1', '/admin/people', '/admin/audit'];
const EVERY = [...GATE, ...MEMBER, ...ADMIN_ONLY, ...CONSOLE, '/settings/security'];

describe('access routing (spec 4.3)', () => {
  test('each state has its own route', () => {
    expect(HOME).toEqual({
      staff: '/admin/overview',
      staff_setup_required: '/settings/security',
      staff_reauth_required: null,
      member: '/dashboard',
      invited: '/joining',
      pending: '/waiting',
      rejected: '/no-access',
      removed: '/no-access',
      org_suspended: '/no-access',
      no_org: '/request-access',
    });
  });

  test.each(ALL)('%s may stay on its own route, so a redirect never loops', (_name, access) => {
    const me = access.state.startsWith('staff') ? staffMe(access) : meOf(access);
    // A staff session that must sign in again has no route: the guard signs it out instead of redirecting.
    const home = homeFor(me);
    if (access.state === 'staff_reauth_required') expect(home).toBeNull();
    else expect(isAllowed(me, home ?? '')).toBe(true);
    if (!access.state.startsWith('staff')) expect(isAllowed(viewAsMe(access), homeFor(meOf(access)) ?? '')).toBe(true);
  });

  test('the paths each state may open; every other path redirects', () => {
    const allowed = (me: Parameters<typeof isAllowed>[0]): string[] => EVERY.filter((path) => isAllowed(me, path));
    expect(allowed(staffMe())).toEqual([...CONSOLE, '/settings/security']);
    expect(allowed(staffMe(ACCESS.staffSetup))).toEqual(['/settings/security']);
    expect(allowed(staffMe(ACCESS.staffReauth))).toEqual(['/settings/security']);
    expect(allowed(meOf(ACCESS.member))).toEqual([...MEMBER, '/settings/security']);
    expect(allowed(meOf(ACCESS.admin))).toEqual([...MEMBER, ...ADMIN_ONLY, '/settings/security']);
    expect(allowed(meOf(ACCESS.invited))).toEqual(['/joining', '/settings/security']);
    expect(allowed(meOf(ACCESS.pending))).toEqual(['/waiting', '/settings/security']);
    // Request access is open from No access, by choice, for rejected and removed; not for a paused organization.
    expect(allowed(meOf(ACCESS.rejected))).toEqual(['/request-access', '/no-access', '/settings/security']);
    expect(allowed(meOf(ACCESS.removed))).toEqual(['/request-access', '/no-access', '/settings/security']);
    expect(allowed(meOf(ACCESS.suspended))).toEqual(['/no-access', '/settings/security']);
    expect(allowed(meOf(ACCESS.noOrg))).toEqual(['/request-access', '/settings/security']);
  });

  test('view-as routes as the target, never into the console or the staff member’s own two-step settings', () => {
    const allowed = (access: Access): string[] => EVERY.filter((path) => isAllowed(viewAsMe(access), path));
    expect(allowed(ACCESS.admin)).toEqual([...MEMBER, ...ADMIN_ONLY]);
    expect(allowed(ACCESS.member)).toEqual(MEMBER);
    expect(allowed(ACCESS.pending)).toEqual(['/waiting']);
    expect(allowed(ACCESS.noOrg)).toEqual(['/request-access']);
  });

  test('open as admin routes as the organization’s admin without Team, never into the console', () => {
    expect(EVERY.filter((path) => isAllowed(openAsAdminMe(), path))).toEqual([...MEMBER, '/locations/new', '/locations/l1/settings', '/settings/security']);
    expect(isAllowed(openAsAdminMe(), homeFor(openAsAdminMe()) ?? '')).toBe(true);
  });

  test('paths are compared without a trailing slash, query or fragment', () => {
    expect(isAllowed(meOf(ACCESS.member), '/dashboard/')).toBe(true);
    expect(isAllowed(meOf(ACCESS.member), '/dashboard?x=1')).toBe(true);
    expect(isAllowed(meOf(ACCESS.member), '/locations/l1/nope')).toBe(false);
    expect(isAllowed(meOf(ACCESS.member), '/locations/l1/orders/setup/')).toBe(true);
    expect(isAllowed(meOf(ACCESS.member), '/locations/l1/orders/nope')).toBe(false);
  });

  test('isAllowed lets members open /locations/x/calendar, with or without ?day=', () => {
    for (const me of [meOf(ACCESS.member), meOf(ACCESS.admin), viewAsMe(ACCESS.member), openAsAdminMe()]) {
      expect(isAllowed(me, '/locations/x/calendar')).toBe(true);
      expect(isAllowed(me, '/locations/x/calendar?day=2026-11-21')).toBe(true);
      expect(isAllowed(me, calendarHref('x', '2026-11-21'))).toBe(true);
    }
    expect(isAllowed(meOf(ACCESS.pending), '/locations/x/calendar')).toBe(false);
    expect(isAllowed(staffMe(), '/locations/x/calendar')).toBe(false);
    expect(isAllowed(meOf(ACCESS.member), '/locations/x/calendar/2026-11')).toBe(false);
  });

  test('/locations/l1/rules is a member page, allowed under view-as and open as admin', () => {
    for (const me of [meOf(ACCESS.member), meOf(ACCESS.admin), viewAsMe(ACCESS.member), viewAsMe(ACCESS.admin), openAsAdminMe()]) {
      expect(isAllowed(me, '/locations/l1/rules')).toBe(true);
    }
    expect(isAllowed(meOf(ACCESS.pending), '/locations/l1/rules')).toBe(false);
    expect(isAllowed(staffMe(), '/locations/l1/rules')).toBe(false);
    expect(isAllowed(meOf(ACCESS.member), '/locations/l1/rules/r1')).toBe(false);
  });

  test('an item’s page needs u_, f_ or c_ and exactly 24 lower-case hex digits (P27, D49); anything looser redirects', () => {
    const hex = '0123456789abcdef01234567';
    expect(isAllowed(meOf(ACCESS.member), `/locations/l1/data/u_${hex}/`)).toBe(true);
    expect(isAllowed(meOf(ACCESS.member), `/locations/l1/data/c_${hex}`)).toBe(true);
    expect(isAllowed(viewAsMe(ACCESS.member), `/locations/l1/data/c_${hex}`)).toBe(true);
    for (const path of [
      `/locations/l1/data/x_${hex}`, `/locations/l1/data/F_${hex}`, `/locations/l1/data/f_${hex.toUpperCase()}`, `/locations/l1/data/f_${hex.slice(1)}`,
      `/locations/l1/data/f_${hex}0`, `/locations/l1/data/${hex}`, `/locations/l1/data/f_${hex}/edit`, '/locations/l1/data/text', '/locations/l1/data/u_',
      `/locations/l1/data/f_${hex.slice(0, 23)}g`, `/locations/l1/data//f_${hex}`, `/locations/l1/data/C_${hex}`, `/locations/l1/data/c_${hex}/events`,
    ]) {
      expect({ path, allowed: isAllowed(meOf(ACCESS.admin), path) }).toEqual({ path, allowed: false });
    }
  });
});

describe('navigation per role (spec 15.3)', () => {
  const rows = (items: ReturnType<typeof clientNav>): (string | boolean | null)[][] =>
    items.map((item) => [item.label, item.href, item.current, item.end === true]);

  test('members: the location’s sections, then Settings as the right-hand group', () => {
    expect(rows(clientNav('member', '/locations/l1', 'l1'))).toEqual([
      ['Home', '/locations/l1', 'page', false], ['TownwiseAI', '/locations/l1/agent', null, false],
      ['Calendar', '/locations/l1/calendar', null, false], ['Orders', '/locations/l1/orders', null, false],
      ['Analytics', '/locations/l1/analytics', null, false], ['Notes', '/locations/l1/notes', null, false],
      ['Rules', '/locations/l1/rules', null, false],
      ['Town', '/locations/l1/town', null, false], ['Your data', '/locations/l1/data', null, false],
      ['Settings', '/settings', null, true],
    ]);
  });

  test('clientNav lists TownwiseAI right after Home, then Calendar', () => {
    expect(clientNav('org_admin', '/locations/l1/calendar', 'l1').map((item) => item.label)).toEqual([
      'Home', 'TownwiseAI', 'Calendar', 'Orders', 'Analytics', 'Notes', 'Rules', 'Town', 'Your data', 'Location settings', 'Team', 'Settings',
    ]);
  });

  test('clientNav lists Rules (P29) right after Notes, for members as for org admins', () => {
    for (const role of ['member', 'org_admin'] as const) {
      const labels = clientNav(role, '/locations/l1', 'l1').map((item) => item.label);
      expect(labels.indexOf('Rules')).toBe(labels.indexOf('Notes') + 1);
    }
    expect(clientNav('member', '/locations/l1', 'l1').find((item) => item.label === 'Rules')?.href).toBe('/locations/l1/rules');
  });

  test('Notes, Rules, Town and Your data sit under More (D38), then Location settings for org admins; no other item does', () => {
    for (const role of ['member', 'org_admin'] as const) {
      const items = clientNav(role, '/locations/l1/sales/upload', 'l1');
      const admin: [string, string | null][] = role === 'org_admin' ? [['Location settings', null]] : [];
      expect(items.filter((item) => item.more === true).map((item) => [item.label, item.current])).toEqual([
        ['Notes', null], ['Rules', null], ['Town', null], ['Your data', 'true'], ...admin,
      ]);
      // They are the sections' last ones, so More takes Notes' place, right after Analytics.
      const first = items.findIndex((item) => item.more === true);
      expect(items[first - 1]?.label).toBe('Analytics');
      expect(items.slice(first, first + 4 + admin.length).every((item) => item.more === true)).toBe(true);
    }
    // Location settings (P16) is the org admin's alone, and opens the location's own page.
    expect(clientNav('member', '/locations/l1', 'l1').map((item) => item.label)).not.toContain('Location settings');
    expect(clientNav('org_admin', '/locations/l1', 'l1').find((item) => item.label === 'Location settings')?.href).toBe('/locations/l1/settings');
    expect(clientNav('org_admin', '/dashboard', null).some((item) => item.more === true)).toBe(false);
  });

  test('org admins add Team, which starts the right-hand group', () => {
    expect(rows(clientNav('org_admin', '/team', 'l1')).slice(-2)).toEqual([['Team', '/team', 'page', true], ['Settings', '/settings', null, false]]);
    expect(clientNav('org_admin', '/settings/security', 'l1').map((item) => item.current).slice(-2)).toEqual([null, 'true']);
  });

  test('open as admin: the top bar has no Team', () => {
    expect(clientNav('org_admin', '/dashboard', 'l1', true).map((item) => item.label)).not.toContain('Team');
    expect(clientNav('org_admin', '/dashboard', 'l1').map((item) => item.label)).toContain('Team');
    expect(clientNav('org_admin', '/dashboard', null, true).map((item) => [item.label, item.end === true])).toEqual([['Settings', true]]);
  });

  test('with no location (none yet, or the organization still loading off a location page) only Team and Settings', () => {
    expect(rows(clientNav('member', '/dashboard', null))).toEqual([['Settings', '/settings', null, true]]);
    expect(clientNav('org_admin', '/dashboard', null).map((item) => item.label)).toEqual(['Team', 'Settings']);
  });

  test('current: each section on its own page; Analytics also on Sales data, which lives under it; Orders on Ordering setup; Your data on Upload', () => {
    const current = (path: string): [string, string | null][] =>
      clientNav('org_admin', path, 'l1').filter((item) => item.current !== null).map((item) => [item.label, item.current]);
    expect(current('/locations/l1/analytics')).toEqual([['Analytics', 'page']]);
    expect(current('/locations/l1/sales')).toEqual([['Analytics', 'true']]);
    expect(current('/locations/l1/orders')).toEqual([['Orders', 'page']]);
    expect(current('/locations/l1/orders/setup')).toEqual([['Orders', 'true']]);
    expect(current('/locations/l1/sales/upload')).toEqual([['Your data', 'true']]);
    expect(current('/locations/l1/data')).toEqual([['Your data', 'page']]);
    expect(current(FILE_ITEM)).toEqual([['Your data', 'true']]);
    expect(current(UPLOAD_ITEM)).toEqual([['Your data', 'true']]);
    expect(current(CALENDAR_ITEM)).toEqual([['Your data', 'true']]);
    // Another location's item marks nothing here.
    expect(current('/locations/l2/data/f_89abcdef0123456789abcdef')).toEqual([]);
    expect(current('/locations/l1/agent')).toEqual([['TownwiseAI', 'page']]);
    // Business rules (P29) has its own section, Rules.
    expect(current('/locations/l1/rules')).toEqual([['Rules', 'page']]);
    expect(current('/locations/l1/calendar')).toEqual([['Calendar', 'page']]);
    expect(current('/locations/l1/notes/')).toEqual([['Notes', 'page']]);
    expect(current('/locations/l1/town')).toEqual([['Town', 'page']]);
    // Location settings is under More; Settings is the account page.
    expect(current('/locations/l1/settings')).toEqual([['Location settings', 'page']]);
    expect(current('/settings')).toEqual([['Settings', 'page']]);
    // Off a location the sections open another location, so none of them is current.
    expect(current('/dashboard')).toEqual([]);
  });

  test('the sections open the location in the path, else the last one opened, else the organization’s first', () => {
    const locations = [{ id: 'l1' }, { id: 'l2' }];
    expect(navLocationId('/locations/l2/notes', 'l1', locations)).toBe('l2');
    expect(navLocationId('/settings', 'l2', locations)).toBe('l2');
    expect(navLocationId('/settings', null, locations)).toBe('l1');
    // A location the organization no longer has is passed over, whether in the path or remembered.
    expect(navLocationId('/locations/l404', 'l404', locations)).toBe('l1');
    expect(navLocationId('/team', 'l404', locations)).toBe('l1');
    // While the organization loads, the path and the last location are taken on trust; with neither, no sections.
    expect(navLocationId('/locations/l2/town', null, null)).toBe('l2');
    expect(navLocationId('/settings', 'l2', null)).toBe('l2');
    expect(navLocationId('/settings', null, null)).toBeNull();
    expect(navLocationId('/dashboard', 'l1', [])).toBeNull();
    expect(navLocationId('/locations/new', null, locations)).toBe('l1');
  });

  test('staff: Overview first, then Requests with its count, Organizations, People, Audit log', () => {
    const nav = (path: string) => consoleNav(path, 4).map((item) => [item.label, item.href, item.current, item.count ?? null]);
    expect(nav('/admin/orgs/o1')).toEqual([
      ['Overview', '/admin/overview', null, null], ['Requests', '/admin', null, 4], ['Organizations', '/admin/orgs', 'true', null],
      ['People', '/admin/people', null, null], ['Audit log', '/admin/audit', null, null],
    ]);
    // Overview is current on its own page, with any window, and Requests stays /admin, current only there.
    expect(nav('/admin/overview?days=90').map(([label, , current]) => [label, current])).toEqual([
      ['Overview', 'page'], ['Requests', null], ['Organizations', null], ['People', null], ['Audit log', null],
    ]);
    expect(nav('/admin').map(([label, , current]) => [label, current])).toEqual([
      ['Overview', null], ['Requests', 'page'], ['Organizations', null], ['People', null], ['Audit log', null],
    ]);
  });

  test('staff land on Overview; a member, view-as and staff in setup may not open it', () => {
    expect(homeFor(staffMe())).toBe('/admin/overview');
    expect(isAllowed(staffMe(), '/admin/overview')).toBe(true);
    expect(isAllowed(meOf(ACCESS.admin), '/admin/overview')).toBe(false);
    expect(isAllowed(viewAsMe(ACCESS.admin), '/admin/overview')).toBe(false);
    expect(isAllowed(staffMe(ACCESS.staffSetup), '/admin/overview')).toBe(false);
  });

  test('every location page’s section, address and title', () => {
    const today = new Date(2026, 10, 5);
    const pages: [string, TabKey, string][] = [
      ['/locations/l1', 'home', 'Week of Nov 2, 2026'],
      ['/locations/l1/calendar', 'calendar', 'Calendar'],
      ['/locations/l1/orders', 'orders', 'Orders'],
      ['/locations/l1/orders/setup', 'ordersSetup', 'Ordering setup'],
      ['/locations/l1/analytics', 'analytics', 'Analytics'],
      ['/locations/l1/sales', 'sales', 'Sales data'],
      ['/locations/l1/sales/upload', 'upload', 'Upload'],
      ['/locations/l1/data', 'data', 'Your data'],
      ['/locations/l1/notes', 'notes', 'Notes'],
      ['/locations/l1/town', 'town', 'Town'],
      ['/locations/l1/agent', 'agent', 'TownwiseAI'],
      ['/locations/l1/rules', 'rules', 'Business rules'],
      ['/locations/l1/settings', 'settings', 'Location settings'],
    ];
    for (const [path, key, title] of pages) {
      expect(tabOf(path)).toBe(key);
      expect(locationHref('l1', key)).toBe(path);
      expect(pageTitle(key, today)).toBe(title);
    }
    // The old chat address belongs to TownwiseAI, where it redirects, and an item's page to Your data.
    expect(tabOf('/locations/l1/chat')).toBe('agent');
    // D59: TownwiseAI's log of its changes is TownwiseAI's, and scrolls as a page.
    expect(tabOf('/locations/l1/agent/changes')).toBe('agent');
    expect(isFillRoute('/locations/l1/agent/changes')).toBe(false);
    expect(tabOf(FILE_ITEM)).toBe('data');
    expect(tabOf(UPLOAD_ITEM)).toBe('data');
    expect(tabOf(CALENDAR_ITEM)).toBe('data');
    expect(itemHref('l1', 'f_89abcdef0123456789abcdef')).toBe(FILE_ITEM);
    expect(locationHref('a b')).toBe('/locations/a%20b');
    // Home's days open the Calendar at a day (?day=).
    expect(calendarHref('l1')).toBe('/locations/l1/calendar');
    expect(calendarHref('a b', '2026-11-21')).toBe('/locations/a%20b/calendar?day=2026-11-21');
    expect(tabOf(calendarHref('l1', '2026-11-21'))).toBe('calendar');
  });

  test('Home’s title is the Monday of this week on the device’s calendar, across a month and a year', () => {
    expect(pageTitle('home', new Date(2026, 10, 2))).toBe('Week of Nov 2, 2026');
    expect(pageTitle('home', new Date(2026, 10, 8, 23, 59))).toBe('Week of Nov 2, 2026');
    expect(pageTitle('home', new Date(2026, 9, 1))).toBe('Week of Sep 28, 2026');
    expect(pageTitle('home', new Date(2027, 0, 1))).toBe('Week of Dec 28, 2026');
  });

  test('TownwiseAI (and the old chat address, while it redirects) fills the screen', () => {
    expect(isFillRoute('/locations/l1/agent')).toBe(true);
    expect(isFillRoute('/locations/l1/chat')).toBe(true);
    expect(isFillRoute('/locations/l1')).toBe(false);
    expect(isFillRoute('/locations/l1/analytics')).toBe(false);
  });
});

describe('schemas', () => {
  test('GET /api/me parses every access state and strips unknown keys', () => {
    for (const [, access] of ALL) {
      const parsed = meResponseSchema.parse({ ...meOf(access), extra: 1, access: { ...access, extra: 1 } });
      expect(parsed).toEqual(meOf(access));
    }
    expect(meResponseSchema.parse(viewAsMe(ACCESS.admin)).viewAs?.target.email).toBe('gm@example.org');
    // An answer without openAsAdmin parses; one with it keeps it.
    expect(meResponseSchema.parse(meOf(ACCESS.admin)).openAsAdmin).toBeUndefined();
    expect(meResponseSchema.parse({ ...openAsAdminMe(), extra: 1 })).toEqual(openAsAdminMe());
    expect(meResponseSchema.parse({ ...meOf(ACCESS.admin), openAsAdmin: null }).openAsAdmin).toBeNull();
  });

  test('a response that does not match is refused', () => {
    expect(meResponseSchema.safeParse({ ...meOf(ACCESS.noOrg), access: { state: 'unknown' } }).success).toBe(false);
    expect(orgResponseSchema.safeParse({ ...orgOf('member'), role: 'owner' }).success).toBe(false);
    expect(orgResponseSchema.parse(orgOf('org_admin', undefined, 3)).requestedLocationCount).toBe(3);
  });

  test('the calibration states calibrated and stale parse before the API sends them (14.3, D42)', () => {
    const days = { dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-11-21' };
    const stale = { state: 'stale', ...days, dataThrough: '2026-11-15', newerDays: 6, nextRefresh: '2026-11-23' };
    expect(calibrationSchema.parse(stale)).toEqual(stale);
    expect(calibrationSchema.parse({ ...stale, nextRefresh: null }).state).toBe('stale');
    const calibrated = { state: 'calibrated', ...days, dataThrough: '2026-11-21', newerDays: 0, nextRefresh: null };
    expect(calibrationSchema.parse(calibrated)).toEqual(calibrated);
    expect(calibrationSchema.safeParse({ state: 'stale', ...days }).success).toBe(false);
    expect(calibrationSchema.safeParse({ state: 'queued' }).success).toBe(false);
  });
});

describe('errors (spec 15.7, 10.9)', () => {
  test('the shared copy, word for word', () => {
    expect(errorCopy(new ApiError('network', 'x'))).toBe('Can’t reach Townwise. Check your connection and try again.');
    expect(errorCopy(new ApiError('timeout', 'x'))).toBe('Can’t reach Townwise. Check your connection and try again.');
    expect(errorCopy(refusal(503, 'unavailable'))).toBe('Townwise isn’t responding. Try again in a minute.');
    expect(errorCopy(refusal(500, 'internal'))).toBe('Something went wrong on our side. Try again in a minute.');
    expect(errorCopy(refusal(400, 'invalid_request'))).toBe('Something went wrong with that request. Reload the page and try again.');
    expect(errorCopy(refusal(429, 'rate_limited', 600))).toBe('Too many attempts. Try again in 10 minutes.');
    expect(tooManyAttempts(30)).toBe('Too many attempts. Try again in 1 minute.');
    expect(errorCopy(new Error('x'))).toBe('Something went wrong on our side. Try again in a minute.');
  });

  test('the answers that re-read GET /api/me', () => {
    for (const code of ['no_access', 'forbidden', 'staff_setup_required', 'staff_reauth_required']) {
      expect(needsRecheck(refusal(403, code))).toBe(true);
    }
    expect(needsRecheck(refusal(409, 'view_as_active'))).toBe(true);
    expect(needsRecheck(refusal(409, 'open_as_admin_active'))).toBe(true);
    expect(needsRecheck(refusal(403, 'open_as_admin_refused'))).toBe(false);
    expect(needsRecheck(refusal(403, 'view_as_read_only'))).toBe(false);
    expect(needsRecheck(refusal(409, 'request_exists'))).toBe(false);
    expect(needsRecheck(new ApiError('network', 'x'))).toBe(false);
  });
});

describe('formats (spec 15.7)', () => {
  test('numbers, dates and times', () => {
    expect(formatCount(1204)).toBe('1,204');
    expect(formatCount(-3)).toBe('−3');
    expect(plural(1, 'day', 'days')).toBe('1 day');
    expect(plural(1204, 'day', 'days')).toBe('1,204 days');
    expect(formatDate('2026-03-02')).toBe('Mar 2, 2026');
    expect(formatTime(new Date(2026, 10, 4, 15, 42))).toBe('3:42 PM');
    expect(formatTime(new Date(2026, 10, 4, 0, 5))).toBe('12:05 AM');
    expect(formatTime(new Date(2026, 10, 4, 12, 0))).toBe('12:00 PM');
  });
});

describe('towns (spec 13)', () => {
  test('the Town select groups the twelve towns as the homepage lists them', () => {
    expect(TOWN_GROUPS.map((group) => [group.label, group.options.map((option) => option.label)])).toEqual([
      ['College towns', ['Hanover, NH', 'Amherst, MA', 'Ithaca, NY', 'Burlington, VT', 'Middlebury, VT', 'State College, PA']],
      ['Seasonal and event towns', ['Bar Harbor, ME', 'Stowe, VT', 'Conway, NH', 'North Elba, NY', 'Provincetown, MA', 'Nantucket, MA']],
    ]);
  });

  test('the pattern matches the homepage map for every town, and neither has one without a series', () => {
    for (const town of mapTowns) {
      expect(town.series === null ? null : patternOf(town.series)).toBe(town.pattern);
      expect(townProfile(town.id)?.pattern).toBe(town.pattern);
    }
  });

  test('what Townwise has on a town, in words', () => {
    expect(townResearchLine('hanover-nh')).toMatch(/^2 drivers and \d key dates?, from public sources$/);
    expect(townResearchLine('conway-nh')).toBe('1 driver and no key dates, from public sources');
    // Nantucket has no drivers, and BLS withheld its county for April to June 2025, so it has no pattern either.
    expect(townResearchLine('nantucket-ma')).toBe('No 2025 jobs index. Drivers aren’t researched yet.');
    expect(townResearchLine(null)).toBe('Not researched yet');
    expect(townProfile('nowhere')).toBeNull();
  });

  // A source's link text went with the source chips (test/portal/sources/site.test.ts).
  test('date ranges', () => {
    expect(dateRange('2025-11-22', null)).toBe('Nov 22, 2025');
    expect(dateRange('2025-11-22', '2025-12-01')).toBe('Nov 22 to Dec 1, 2025');
    expect(dateRange('2025-12-30', '2026-01-02')).toBe('Dec 30, 2025 to Jan 2, 2026');
  });

  test('the Town field checks Another town’s name and state', () => {
    expect(checkTown({ choice: '', name: '', state: '' })).toEqual({ messages: { choice: 'Pick a town, or choose Another town.' } });
    expect(checkTown({ choice: 'stowe-vt', name: '', state: '' })).toEqual({ input: { townId: 'stowe-vt' } });
    expect(checkTown({ choice: 'another', name: ' Norwich ', state: 'vt' })).toEqual({ input: { townId: null, name: 'Norwich', state: 'VT' } });
    expect(checkTown({ choice: 'another', name: '', state: 'XX' })).toEqual({
      messages: { name: 'Enter the town’s name.', state: 'Choose a state.' },
    });
  });
});
