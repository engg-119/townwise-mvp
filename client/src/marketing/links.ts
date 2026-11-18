// The marketing pages' links, used by the header, the footer and the tests. Internal hrefs are app
// routes; /#id targets a section of the homepage.

export interface MarketingLink {
  label: string;
  href: string;
}

export interface LinkGroup {
  title: string;
  links: readonly MarketingLink[];
}

export const SIGN_IN_HREF = '/sign-in';
// The portal's Request access form (docs/portal/spec.md P3). A signed-out visitor is sent to sign in with Google
// first; a person with no organization then lands on the form, and staff see the request on /admin.
export const EARLY_ACCESS_HREF = '/request-access';
// The one contact address, shown on the pages and linked by CONTACT_HREF. The mailbox does not exist yet (launch
// blocker). The portal imports both through src/portal/contact.ts, so changing the address here changes every page.
export const CONTACT_EMAIL = 'hello@townwise.tech';
export const CONTACT_HREF = `mailto:${CONTACT_EMAIL}`;

// The open-source notices: a plain-text file the site serves (public/licenses/), not an app route.
export const NOTICES_HREF = '/licenses/NOTICE.txt';

export const navLinks: readonly MarketingLink[] = [
  { label: 'The map', href: '/#map' },
  { label: 'How it works', href: '/#how' },
  { label: 'What you get', href: '/#product' },
  { label: 'FAQ', href: '/#faq' },
];

export const footerGroups: readonly LinkGroup[] = [
  { title: 'Product', links: navLinks },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: CONTACT_HREF },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
      { label: 'Security', href: '/security' },
      { label: 'Open-source notices', href: NOTICES_HREF },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Sign in', href: SIGN_IN_HREF },
      { label: 'Request early access', href: EARLY_ACCESS_HREF },
    ],
  },
];
