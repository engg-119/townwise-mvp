import { formatDate } from './format';
import type { AccessState, MeResponse, Role } from './schemas';

// Access routing (spec 4.3) and the navigation per role (15.3), as pure functions of GET /api/me and the path.
// The portal layout (app/(gate)/(app)/_layout.tsx) redirects any path isAllowed refuses to homeFor. A new page
// adds its path here, in the state or role that may open it, or it redirects.

/**
 * Each access state's own route (4.3). Staff in view-as are routed by the target's access. `staff_reauth_required` has
 * none: the guard signs the session out instead, so staff sign in again on the ordinary sign-in page.
 */
export const HOME: Readonly<Record<AccessState, string | null>> = {
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
};

/** The gate pages and the states that may open them. Request access is also open from No access, by choice. */
const GATE_PAGES: Readonly<Record<string, readonly AccessState[]>> = {
  '/request-access': ['no_org', 'rejected', 'removed'],
  '/waiting': ['pending'],
  '/no-access': ['rejected', 'removed', 'org_suspended'],
  '/joining': ['invited'],
};

const ID = '[^/]+';
/**
 * A Your data item's ref (D28): `u_` for an upload or `f_` for a stored file, then its 24-hex id; or `c_` for one of
 * the location's calendars (D49), a client-only ref whose page reads the calendar routes, never the data item's.
 */
const ITEM_REF = '[ufc]_[0-9a-f]{24}';
const ITEM_REF_ONLY = new RegExp(`^${ITEM_REF}$`);
/**
 * Client app pages any member may open (P9, P11 to P15, P18, P24 Analytics, P25 TownwiseAI, P26 Your data and P27 an
 * item of it, P28 Calendar, P29 Business rules, P30 Orders and P31 its Ordering setup), and (D59) TownwiseAI's log of
 * its changes, `agent/changes`. `chat` is the tuning chat's old address, which redirects to `agent`. The Calendar's
 * `?day=` is a query, so it never changes this.
 */
const MEMBER_PAGES = new RegExp(
  `^/(dashboard|settings|locations/${ID}(/(analytics|sales|sales/upload|data|data/${ITEM_REF}|notes|town|orders|orders/setup|agent|agent/changes|chat|calendar|rules))?)$`,
);
/** Client app pages for org admins only (P10, P16, P17). Checked before MEMBER_PAGES: /locations/new is not an id. */
const ADMIN_PAGES = new RegExp(`^/(team|locations/new|locations/${ID}/settings)$`);
const CONSOLE_PAGES = /^\/admin(\/.*)?$/;

/** The access's own route, or null when the session has to sign in again first. */
export function homeFor(me: MeResponse): string | null {
  return HOME[me.access.state];
}

function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Whether this person may stay on this path. Anything else redirects to homeFor(me). */
export function isAllowed(me: MeResponse, pathname: string): boolean {
  const path = normalize(pathname);
  const { access } = me;
  // Two-step settings are the signed-in person's own kit account. Under view-as they would be the staff
  // member's, not the target's, so view-as never shows them.
  if (path === '/settings/security') return me.viewAs === null;
  // Team is closed while staff set up an organization as its admin; the console shows the team (D25).
  if (path === '/team' && me.openAsAdmin != null) return false;
  // `staff` is never the access during view-as: the access is then the target's.
  if (CONSOLE_PAGES.test(path)) return access.state === 'staff';
  const gate = GATE_PAGES[path];
  if (gate !== undefined) return gate.includes(access.state);
  if (access.state !== 'member') return false;
  if (ADMIN_PAGES.test(path)) return access.role === 'org_admin';
  return MEMBER_PAGES.test(path);
}

/** `page` on the item's own page, `true` on a page below it (shell.md 5.5). */
export type Current = 'page' | 'true' | null;

export interface NavItem {
  label: string;
  href: string;
  current: Current;
  /** The console's pending request count, printed after the label. */
  count?: number | null;
  /** The item starts the bar's right-hand group (Team, Settings), after the location's sections. */
  end?: boolean;
  /** The item sits under the bar's More control (D38), which takes the place of the first such item. */
  more?: boolean;
}

function currentFor(path: string, own: string, below: RegExp | null): Current {
  if (path === own) return 'page';
  return below?.test(path) === true ? 'true' : null;
}

/** Whether `path` is an item's page under Your data's `dataHref`. */
function isItemPath(path: string, dataHref: string): boolean {
  return path.startsWith(`${dataHref}/`) && ITEM_REF_ONLY.test(path.slice(dataHref.length + 1));
}

export type TabKey =
  | 'home' | 'calendar' | 'orders' | 'ordersSetup' | 'analytics' | 'sales' | 'upload' | 'data' | 'notes' | 'town' | 'agent' | 'rules'
  | 'settings';

const TAB_SUFFIX: Readonly<Record<TabKey, string>> = {
  home: '', calendar: '/calendar', orders: '/orders', ordersSetup: '/orders/setup', analytics: '/analytics', sales: '/sales',
  upload: '/sales/upload', data: '/data', notes: '/notes', town: '/town', agent: '/agent', rules: '/rules', settings: '/settings',
};

/** The location's sections in the top bar, in order (15.3). Sales data is reached from pages; Location settings is for org admins. */
const SECTIONS: readonly (readonly [TabKey, string])[] = [
  ['home', 'Home'], ['agent', 'TownwiseAI'], ['calendar', 'Calendar'], ['orders', 'Orders'], ['analytics', 'Analytics'], ['notes', 'Notes'],
  ['rules', 'Rules'], ['town', 'Town'], ['data', 'Your data'], ['settings', 'Location settings'],
];

/** The sections under More (D38): what the forecast reads, set up once or now and then. */
const MORE: ReadonlySet<TabKey> = new Set(['notes', 'rules', 'town', 'data', 'settings']);

/**
 * The client app's top bar (15.3): the sections of `locationId` (Home, TownwiseAI, Calendar, Orders, Analytics, Notes, Rules,
 * Town, Your data, and Location settings for org admins, all from Notes on under More), then Team for org admins (not while staff open the organization as admin) and Settings. With no location (none yet, or not known yet) only Team and Settings.
 * Analytics also marks Sales data, which lives under it, and Orders its Ordering setup. Rules opens Business rules (P29), for every member.
 */
export function clientNav(role: Role, pathname: string, locationId: string | null, openAsAdmin = false): NavItem[] {
  const path = normalize(pathname);
  const items: NavItem[] = [];
  if (locationId !== null) {
    for (const [key, label] of SECTIONS) {
      if (key === 'settings' && role !== 'org_admin') continue;
      const href = locationHref(locationId, key);
      // Analytics also marks Sales data, which lives under it; Orders its Ordering setup; Your data also marks Upload,
      // which is reached from it, and an item's page, which lives under it.
      const current = currentFor(path, href, null)
        ?? (key === 'analytics' && path === locationHref(locationId, 'sales') ? 'true' : null)
        ?? (key === 'orders' && path === locationHref(locationId, 'ordersSetup') ? 'true' : null)
        ?? (key === 'data' && (path === locationHref(locationId, 'upload') || isItemPath(path, href)) ? 'true' : null);
      items.push({ label, href, current, ...(MORE.has(key) ? { more: true } : {}) });
    }
  }
  const account: NavItem[] = role === 'org_admin' && !openAsAdmin ? [{ label: 'Team', href: '/team', current: currentFor(path, '/team', null) }] : [];
  account.push({ label: 'Settings', href: '/settings', current: currentFor(path, '/settings', /^\/settings\//) });
  return [...items, ...account.map((item, index) => (index === 0 ? { ...item, end: true } : item))];
}

/** The staff console's top bar (15.4): Overview (P32), where staff land, first. */
export function consoleNav(pathname: string, pendingCount: number | null): NavItem[] {
  const path = normalize(pathname);
  return [
    { label: 'Overview', href: '/admin/overview', current: currentFor(path, '/admin/overview', null) },
    { label: 'Requests', href: '/admin', current: currentFor(path, '/admin', null), count: pendingCount },
    { label: 'Organizations', href: '/admin/orgs', current: currentFor(path, '/admin/orgs', /^\/admin\/orgs\//) },
    { label: 'People', href: '/admin/people', current: currentFor(path, '/admin/people', null) },
    { label: 'Audit log', href: '/admin/audit', current: currentFor(path, '/admin/audit', null) },
  ];
}

/**
 * The section a location path belongs to. The old chat address and (D59) the log of TownwiseAI's changes belong to
 * TownwiseAI, and an item's page to Your data.
 */
export function tabOf(pathname: string): TabKey {
  const rest = /^\/locations\/[^/]+(\/.*)?$/.exec(normalize(pathname))?.[1] ?? '';
  if (rest === '/chat' || rest === '/agent/changes') return 'agent';
  if (isItemPath(rest, '/data')) return 'data';
  const found = (Object.keys(TAB_SUFFIX) as TabKey[]).find((key) => TAB_SUFFIX[key] === rest && key !== 'home');
  return found ?? 'home';
}

/**
 * The location id in a location path. Read from the path rather than the layout's search params, which keep the
 * first location's id after the switcher opens another one.
 */
export function locationIdOf(pathname: string): string | null {
  const id = /^\/locations\/([^/]+)/.exec(normalize(pathname))?.[1];
  return id === undefined || id === 'new' ? null : decodeURIComponent(id);
}

export function locationHref(locationId: string, tab: TabKey = 'home'): string {
  return `/locations/${encodeURIComponent(locationId)}${TAB_SUFFIX[tab]}`;
}

/** D65: TownwiseAI's page with its panel open at What it’s been doing, where a location's forecast runs are listed. */
export function activityHref(locationId: string): string {
  return `${locationHref(locationId, 'agent')}?panel=activity`;
}

/** The Calendar (P28), opened at `day` (YYYY-MM-DD) when given, as Home's This month does. */
export function calendarHref(locationId: string, day?: string): string {
  const href = locationHref(locationId, 'calendar');
  return day === undefined ? href : `${href}?day=${encodeURIComponent(day)}`;
}

/** An item's page under Your data (P27); `ref` as the API gives it. */
export function itemHref(locationId: string, ref: string): string {
  return `${locationHref(locationId, 'data')}/${encodeURIComponent(ref)}`;
}

/**
 * The location the top bar's sections open: the one in the path, else the last one opened in this sign-in, else
 * the organization's first. `locations` is null while the organization loads; an id is then taken on trust, and
 * once it has loaded, an id it lacks is passed over. Null with no location.
 */
export function navLocationId(pathname: string, lastOpened: string | null, locations: readonly { id: string }[] | null): string | null {
  const known = (id: string | null): id is string => id !== null && (locations === null || locations.some((location) => location.id === id));
  const here = locationIdOf(pathname);
  if (known(here)) return here;
  if (known(lastOpened)) return lastOpened;
  return locations?.[0]?.id ?? null;
}

/** The Monday of `today`'s week, on the device's calendar, as “Nov 2, 2026”. */
function weekOf(today: Date): string {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const two = (value: number): string => String(value).padStart(2, '0');
  return formatDate(`${String(monday.getFullYear())}-${two(monday.getMonth() + 1)}-${two(monday.getDate())}`);
}

/** Each location page's h1, under the eyebrow that names the location (15.2). */
export function pageTitle(tab: TabKey, today: Date): string {
  switch (tab) {
    case 'home': return `Week of ${weekOf(today)}`;
    case 'calendar': return 'Calendar';
    case 'orders': return 'Orders';
    case 'ordersSetup': return 'Ordering setup';
    case 'analytics': return 'Analytics';
    case 'sales': return 'Sales data';
    case 'upload': return 'Upload';
    case 'data': return 'Your data';
    case 'notes': return 'Notes';
    case 'town': return 'Town';
    case 'agent': return 'TownwiseAI';
    case 'rules': return 'Business rules';
    case 'settings': return 'Location settings';
  }
}

/** TownwiseAI lays itself out to fill the screen, so its frame does not scroll (and the old chat address, briefly). */
export function isFillRoute(pathname: string): boolean {
  return /^\/locations\/[^/]+\/(agent|chat)$/.test(normalize(pathname));
}
