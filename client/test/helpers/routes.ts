import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { CONTACT_HREF } from '../../src/marketing/links';

// Every URL the app serves. test/marketing/links.test.ts keeps this list equal to the files in app/.
export const ROUTES = [
  '/', '/about', '/privacy', '/terms', '/security',
  '/sign-in', '/totp', '/auth/magic',
  // The portal (docs/portal/spec.md 16.1): gate pages, the client app, two-step settings and the staff console.
  '/request-access', '/waiting', '/no-access', '/joining', '/settings/security',
  '/dashboard', '/locations/new', '/locations/[locationId]', '/locations/[locationId]/calendar', '/locations/[locationId]/analytics', '/locations/[locationId]/sales',
  '/locations/[locationId]/sales/upload', '/locations/[locationId]/data', '/locations/[locationId]/data/[ref]', '/locations/[locationId]/notes', '/locations/[locationId]/town',
  '/locations/[locationId]/orders', '/locations/[locationId]/orders/setup', '/locations/[locationId]/agent', '/locations/[locationId]/rules',
  '/locations/[locationId]/settings', '/locations/[locationId]/chat', '/team', '/settings',
  '/admin', '/admin/overview', '/admin/orgs', '/admin/orgs/[orgId]', '/admin/people', '/admin/audit',
];

// The homepage sections the nav and footer link to (/#map and so on).
export const HOME_SECTIONS = ['map', 'how', 'product', 'faq'];

export const MAILTO_HREFS = [CONTACT_HREF];

// app/(gate)/(app)/(account)/settings/security.tsx serves /settings/security: groups add no segment,
// index is the directory itself, and _layout and +special files are not pages.
export function routesInAppDir(): string[] {
  return readdirSync(join(__dirname, '../../app'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => file.replace(/\.tsx?$/, '').split(sep))
    .filter((segments) => !/^[_+]/.test(segments.at(-1) ?? ''))
    .map((segments) => segments.filter((segment) => !/^\(.*\)$/.test(segment) && segment !== 'index'))
    .map((segments) => `/${segments.join('/')}`);
}

// Why an href does not resolve, or null when it does. `pageIds` are the ids on the page that holds it.
export function brokenHref(href: string, pageIds: readonly string[] = []): string | null {
  if (href.startsWith('mailto:')) return MAILTO_HREFS.includes(href) ? null : `unexpected mailto ${href}`;
  // The map's public sources (BLS, Census, the published calendars) are external https links.
  if (href.startsWith('https://')) return null;
  if (href.startsWith('#')) return pageIds.includes(href.slice(1)) ? null : `no element with id ${href}`;
  const [path = '', id] = href.split('#');
  // A file the site serves from public/licenses/ (the open-source notices) resolves when it is there.
  if (path.startsWith('/licenses/') && id === undefined) {
    return existsSync(join(__dirname, '..', '..', 'public', ...path.split('/').filter((part) => part !== ''))) ? null : `no file ${path}`;
  }
  if (!ROUTES.includes(path)) return `no route ${path}`;
  if (id !== undefined && !(path === '/' && HOME_SECTIONS.includes(id))) return `no section ${href}`;
  return null;
}
