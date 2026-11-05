import type { AccessState, MeResponse, Role } from './schemas';

// Access routing (spec 4.3) and the navigation per role (15.3), as pure functions of GET /api/me and the path.
// The portal layout (app/(gate)/(app)/_layout.tsx) redirects any path isAllowed refuses to homeFor. A new page
// adds its path here, in the state or role that may open it, or it redirects.

/** Each access state's own route (4.3). Staff in view-as are routed by the target's access. */
export const HOME: Readonly<Record<AccessState, string>> = {
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
};

/** The gate pages and the states that may open them. Request access is also open from No access, by choice. */
const GATE_PAGES: Readonly<Record<string, readonly AccessState[]>> = {
  '/request-access': ['no_org', 'rejected', 'removed'],
  '/waiting': ['pending'],
  '/no-access': ['rejected', 'removed', 'org_suspended'],
  '/joining': ['invited'],
  '/staff/sign-in-again': ['staff_reauth_required'],
};

const ID = '[^/]+';
/** Client app pages any member may open (P9, P11 to P15, P18, and the tuning chat). */
const MEMBER_PAGES = new RegExp(`^/(dashboard|settings|locations/${ID}(/(sales|sales/upload|notes|town|chat))?)$`);
/** Client app pages for org admins only (P10, P16, P17). Checked before MEMBER_PAGES: /locations/new is not an id. */
const ADMIN_PAGES = new RegExp(`^/(team|locations/new|locations/${ID}/settings)$`);
const CONSOLE_PAGES = /^\/admin(\/.*)?$/;

export function homeFor(me: MeResponse): string {
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
}

function currentFor(path: string, own: string, below: RegExp | null): Current {
  if (path === own) return 'page';
  return below?.test(path) === true ? 'true' : null;
}

/** The client app's top bar (15.3): Locations and Settings, with Team for org admins. */
export function clientNav(role: Role, pathname: string): NavItem[] {
  const path = normalize(pathname);
  const items: NavItem[] = [{ label: 'Locations', href: '/dashboard', current: currentFor(path, '/dashboard', /^\/locations\//) }];
  if (role === 'org_admin') items.push({ label: 'Team', href: '/team', current: currentFor(path, '/team', null) });
  items.push({ label: 'Settings', href: '/settings', current: currentFor(path, '/settings', /^\/settings\//) });
  return items;
}

/** The staff console's top bar (15.4). */
export function consoleNav(pathname: string, pendingCount: number | null): NavItem[] {
  const path = normalize(pathname);
  return [
    { label: 'Requests', href: '/admin', current: currentFor(path, '/admin', null), count: pendingCount },
    { label: 'Organizations', href: '/admin/orgs', current: currentFor(path, '/admin/orgs', /^\/admin\/orgs\//) },
    { label: 'People', href: '/admin/people', current: currentFor(path, '/admin/people', null) },
    { label: 'Audit log', href: '/admin/audit', current: currentFor(path, '/admin/audit', null) },
  ];
}

export type TabKey = 'forecast' | 'sales' | 'notes' | 'town' | 'chat' | 'settings';

export interface LocationTab {
  key: TabKey;
  label: string;
  href: string;
  current: boolean;
}

const TAB_SUFFIX: Readonly<Record<TabKey, string>> = {
  forecast: '', sales: '/sales', notes: '/notes', town: '/town', chat: '/chat', settings: '/settings',
};

/** The tab a location path belongs to; the upload step (P13) belongs to Sales data. */
export function tabOf(pathname: string): TabKey {
  const rest = /^\/locations\/[^/]+(\/.*)?$/.exec(normalize(pathname))?.[1] ?? '';
  if (rest === '/sales' || rest.startsWith('/sales/')) return 'sales';
  const found = (Object.keys(TAB_SUFFIX) as TabKey[]).find((key) => TAB_SUFFIX[key] === rest && key !== 'forecast');
  return found ?? 'forecast';
}

/**
 * The location id in a location path. Read from the path rather than the layout's search params, which keep the
 * first location's id after the switcher opens another one.
 */
export function locationIdOf(pathname: string): string | null {
  const id = /^\/locations\/([^/]+)/.exec(normalize(pathname))?.[1];
  return id === undefined || id === 'new' ? null : decodeURIComponent(id);
}

export function locationHref(locationId: string, tab: TabKey = 'forecast'): string {
  return `/locations/${encodeURIComponent(locationId)}${TAB_SUFFIX[tab]}`;
}

/** Forecast, Sales data, Notes, Town and Chat, with Settings for org admins (15.2, 15.3). */
export function locationTabs(locationId: string, role: Role, pathname: string): LocationTab[] {
  const current = tabOf(pathname);
  const tabs: [TabKey, string][] = [['forecast', 'Forecast'], ['sales', 'Sales data'], ['notes', 'Notes'], ['town', 'Town'], ['chat', 'Chat']];
  if (role === 'org_admin') tabs.push(['settings', 'Settings']);
  return tabs.map(([key, label]) => ({ key, label, href: locationHref(locationId, key), current: key === current }));
}

/** The tuning chat lays itself out to fill the screen, so its frame does not scroll. */
export function isFillRoute(pathname: string): boolean {
  return /^\/locations\/[^/]+\/chat$/.test(normalize(pathname));
}
