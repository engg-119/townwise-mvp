import { CONTACT_EMAIL, CONTACT_HREF, EARLY_ACCESS_HREF, footerGroups, navLinks, SIGN_IN_HREF } from '../../src/marketing/links';
import { brokenHref, ROUTES, routesInAppDir } from '../helpers/routes';

test('the route list matches the files in app/', () => {
  expect([...routesInAppDir()].sort()).toEqual([...ROUTES].sort());
});

test('early access is the portal’s Request access form, not an email', () => {
  expect(EARLY_ACCESS_HREF).toBe('/request-access');
  expect(ROUTES).toContain(EARLY_ACCESS_HREF);
  expect(SIGN_IN_HREF).toBe('/sign-in');
});

// The portal shows the address by stripping “mailto:” from CONTACT_HREF, so it must stay a plain mailto.
test('the contact address lives in one constant, and its link is a plain mailto', () => {
  expect(CONTACT_EMAIL).toBe('hello@townwise.tech');
  expect(CONTACT_HREF).toBe('mailto:hello@townwise.tech');
  expect(CONTACT_HREF).toMatch(/^mailto:[^?]+$/);
  expect(CONTACT_HREF.replace(/^mailto:/, '')).toBe(CONTACT_EMAIL);
});

test('the nav links are the four homepage sections', () => {
  expect(navLinks).toEqual([
    { label: 'The map', href: '/#map' },
    { label: 'How it works', href: '/#how' },
    { label: 'What you get', href: '/#product' },
    { label: 'FAQ', href: '/#faq' },
  ]);
});

test('the footer groups match the mockups', () => {
  expect(footerGroups.map((group) => [group.title, group.links.map((link) => link.label)])).toEqual([
    ['Product', ['The map', 'How it works', 'What you get', 'FAQ']],
    ['Company', ['About', 'Contact']],
    ['Legal', ['Privacy', 'Terms', 'Security', 'Open-source notices']],
    ['Account', ['Sign in', 'Request early access']],
  ]);
});

test('every href in links.ts resolves', () => {
  const hrefs = [...navLinks, ...footerGroups.flatMap((group) => group.links)].map((link) => link.href);
  expect(hrefs.map((href) => brokenHref(href)).filter((problem) => problem !== null)).toEqual([]);
});

test('the check rejects hrefs that do not resolve', () => {
  expect(brokenHref('/nope')).toBe('no route /nope');
  expect(brokenHref('/licenses/gone.txt')).toBe('no file /licenses/gone.txt');
  expect(brokenHref('/#nope')).toBe('no section /#nope');
  expect(brokenHref('/about#map')).toBe('no section /about#map');
  expect(brokenHref('#gone', ['here'])).toBe('no element with id #gone');
  expect(brokenHref('mailto:someone@townwise.tech')).toBe('unexpected mailto mailto:someone@townwise.tech');
});
