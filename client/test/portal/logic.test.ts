import { ApiError } from '../../src/api/client';
import { mapTowns } from '../../src/marketing/map/mapState';
import { errorCopy, needsRecheck, tooManyAttempts } from '../../src/portal/errors';
import { formatCount, formatDate, formatTime, plural } from '../../src/portal/format';
import {
  clientNav, consoleNav, HOME, homeFor, isAllowed, isFillRoute, locationHref, navLocationId, pageTitle, tabOf, type TabKey,
} from '../../src/portal/routing';
import { meResponseSchema, orgResponseSchema, type Access } from '../../src/portal/schemas';
import {
  dateRange, patternOf, sourceLinks, TOWN_GROUPS, townProfile, townResearchLine,
} from '../../src/portal/towns';
import { checkTown } from '../../src/portal/ui/TownFields';
import { ACCESS, meOf, openAsAdminMe, orgOf, refusal, staffMe, viewAsMe } from '../helpers/portal';

const ALL: [string, Access][] = Object.entries(ACCESS);

const GATE = ['/request-access', '/waiting', '/no-access', '/joining', '/staff/sign-in-again'];
const MEMBER = [
  '/dashboard', '/settings', '/locations/l1', '/locations/l1/analytics', '/locations/l1/sales', '/locations/l1/sales/upload',
  '/locations/l1/notes', '/locations/l1/town', '/locations/l1/agent', '/locations/l1/chat',
];
const ADMIN_ONLY = ['/team', '/locations/new', '/locations/l1/settings'];
const CONSOLE = ['/admin', '/admin/orgs', '/admin/orgs/o1', '/admin/people', '/admin/audit'];
const EVERY = [...GATE, ...MEMBER, ...ADMIN_ONLY, ...CONSOLE, '/settings/security'];

describe('access routing (spec 4.3)', () => {
  test('each state has its own route', () => {
    expect(HOME).toEqual({
      staff: '/admin',
      staff_setup_required: '/settings/security',
      staff_reauth_required: '/staff/sign-in-again',
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
    expect(isAllowed(me, homeFor(me))).toBe(true);
    if (!access.state.startsWith('staff')) expect(isAllowed(viewAsMe(access), homeFor(meOf(access)))).toBe(true);
  });

  test('the paths each state may open; every other path redirects', () => {
    const allowed = (me: Parameters<typeof isAllowed>[0]): string[] => EVERY.filter((path) => isAllowed(me, path));
    expect(allowed(staffMe())).toEqual([...CONSOLE, '/settings/security']);
    expect(allowed(staffMe(ACCESS.staffSetup))).toEqual(['/settings/security']);
    expect(allowed(staffMe(ACCESS.staffReauth))).toEqual(['/staff/sign-in-again', '/settings/security']);
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
    expect(isAllowed(openAsAdminMe(), homeFor(openAsAdminMe()))).toBe(true);
  });

  test('paths are compared without a trailing slash, query or fragment', () => {
    expect(isAllowed(meOf(ACCESS.member), '/dashboard/')).toBe(true);
    expect(isAllowed(meOf(ACCESS.member), '/dashboard?x=1')).toBe(true);
    expect(isAllowed(meOf(ACCESS.member), '/locations/l1/nope')).toBe(false);
  });
});

describe('navigation per role (spec 15.3)', () => {
  const rows = (items: ReturnType<typeof clientNav>): (string | boolean | null)[][] =>
    items.map((item) => [item.label, item.href, item.current, item.end === true]);

  test('members: the location’s sections, then Settings as the right-hand group', () => {
    expect(rows(clientNav('member', '/locations/l1', 'l1'))).toEqual([
      ['Home', '/locations/l1', 'page', false], ['Analytics', '/locations/l1/analytics', null, false],
      ['TownwiseAI', '/locations/l1/agent', null, false], ['Notes', '/locations/l1/notes', null, false],
      ['Town', '/locations/l1/town', null, false], ['Upload', '/locations/l1/sales/upload', null, false],
      ['Settings', '/settings', null, true],
    ]);
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

  test('current: each section on its own page; Analytics also on Sales data, which lives under it; Upload alone on upload', () => {
    const current = (path: string): [string, string | null][] =>
      clientNav('org_admin', path, 'l1').filter((item) => item.current !== null).map((item) => [item.label, item.current]);
    expect(current('/locations/l1/analytics')).toEqual([['Analytics', 'page']]);
    expect(current('/locations/l1/sales')).toEqual([['Analytics', 'true']]);
    expect(current('/locations/l1/sales/upload')).toEqual([['Upload', 'page']]);
    expect(current('/locations/l1/agent')).toEqual([['TownwiseAI', 'page']]);
    expect(current('/locations/l1/notes/')).toEqual([['Notes', 'page']]);
    expect(current('/locations/l1/town')).toEqual([['Town', 'page']]);
    // Location settings is the header's link, not a top bar item; Settings is the account page.
    expect(current('/locations/l1/settings')).toEqual([]);
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

  test('staff: Requests with its count, Organizations, People, Audit log', () => {
    expect(consoleNav('/admin/orgs/o1', 4).map((item) => [item.label, item.href, item.current, item.count ?? null])).toEqual([
      ['Requests', '/admin', null, 4], ['Organizations', '/admin/orgs', 'true', null],
      ['People', '/admin/people', null, null], ['Audit log', '/admin/audit', null, null],
    ]);
  });

  test('every location page’s section, address and title', () => {
    const today = new Date(2026, 10, 5);
    const pages: [string, TabKey, string][] = [
      ['/locations/l1', 'home', 'Week of Nov 2, 2026'],
      ['/locations/l1/analytics', 'analytics', 'Analytics'],
      ['/locations/l1/sales', 'sales', 'Sales data'],
      ['/locations/l1/sales/upload', 'upload', 'Upload'],
      ['/locations/l1/notes', 'notes', 'Notes'],
      ['/locations/l1/town', 'town', 'Town'],
      ['/locations/l1/agent', 'agent', 'TownwiseAI'],
      ['/locations/l1/settings', 'settings', 'Location settings'],
    ];
    for (const [path, key, title] of pages) {
      expect(tabOf(path)).toBe(key);
      expect(locationHref('l1', key)).toBe(path);
      expect(pageTitle(key, today)).toBe(title);
    }
    // The old chat address belongs to TownwiseAI, where it redirects.
    expect(tabOf('/locations/l1/chat')).toBe('agent');
    expect(locationHref('a b')).toBe('/locations/a%20b');
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

  test('the pattern matches the homepage map for every town', () => {
    for (const town of mapTowns) expect(patternOf(town.series)).toBe(town.pattern);
  });

  test('what Townwise has on a town, in words', () => {
    expect(townResearchLine('hanover-nh')).toMatch(/^2 drivers and \d key dates?, from public sources$/);
    expect(townResearchLine('conway-nh')).toBe('1 driver and no key dates, from public sources');
    expect(townResearchLine('nantucket-ma')).toBe('Employment pattern only. Drivers aren’t researched yet.');
    expect(townResearchLine(null)).toBe('Not researched yet');
    expect(townProfile('nowhere')).toBeNull();
  });

  test('date ranges and source links', () => {
    expect(dateRange('2025-11-22', null)).toBe('Nov 22, 2025');
    expect(dateRange('2025-11-22', '2025-12-01')).toBe('Nov 22 to Dec 1, 2025');
    expect(dateRange('2025-12-30', '2026-01-02')).toBe('Dec 30, 2025 to Jan 2, 2026');
    expect(sourceLinks(['https://www.dartmouth.edu/a', 'https://example.com/a', 'https://example.org/b'])).toEqual([
      { url: 'https://www.dartmouth.edu/a', text: 'dartmouth.edu' },
      { url: 'https://example.com/a', text: 'Source 1' },
      { url: 'https://example.org/b', text: 'Source 2' },
    ]);
  });

  test('the Town field checks Another town’s name and state', () => {
    expect(checkTown({ choice: '', name: '', state: '' })).toEqual({ messages: { choice: 'Pick a town, or choose Another town.' } });
    expect(checkTown({ choice: 'stowe-vt', name: '', state: '' })).toEqual({ input: { townId: 'stowe-vt' } });
    expect(checkTown({ choice: 'another', name: ' Norwich ', state: 'vt' })).toEqual({ input: { townId: null, name: 'Norwich', state: 'VT' } });
    expect(checkTown({ choice: 'another', name: '', state: 'XX' })).toEqual({
      messages: { name: 'Enter the town’s name.', state: 'Enter a two-letter state, for example NH.' },
    });
  });
});
