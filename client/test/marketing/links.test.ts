import { CONTACT_HREF, EARLY_ACCESS_HREF, footerGroups, navLinks, SIGN_IN_HREF } from '../../src/marketing/links';
import { brokenHref, ROUTES, routesInAppDir } from '../helpers/routes';

test('the route list matches the files in app/', () => {
  expect([...routesInAppDir()].sort()).toEqual([...ROUTES].sort());
});

test('the mailto links are exact', () => {
  expect(EARLY_ACCESS_HREF).toBe('mailto:hello@townwise.tech?subject=Townwise%20early%20access');
  expect(CONTACT_HREF).toBe('mailto:hello@townwise.tech');
  expect(SIGN_IN_HREF).toBe('/sign-in');
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
    ['Legal', ['Privacy', 'Terms', 'Security']],
    ['Account', ['Sign in', 'Request early access']],
  ]);
});

test('every href in links.ts resolves', () => {
  const hrefs = [...navLinks, ...footerGroups.flatMap((group) => group.links)].map((link) => link.href);
  expect(hrefs.map((href) => brokenHref(href)).filter((problem) => problem !== null)).toEqual([]);
});

test('the check rejects hrefs that do not resolve', () => {
  expect(brokenHref('/nope')).toBe('no route /nope');
  expect(brokenHref('/#nope')).toBe('no section /#nope');
  expect(brokenHref('/about#map')).toBe('no section /about#map');
  expect(brokenHref('#gone', ['here'])).toBe('no element with id #gone');
  expect(brokenHref('mailto:someone@townwise.tech')).toBe('unexpected mailto mailto:someone@townwise.tech');
});
