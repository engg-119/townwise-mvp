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
// The mailbox does not exist yet (launch blocker).
export const EARLY_ACCESS_HREF = 'mailto:hello@townwise.tech?subject=Townwise%20early%20access';
export const CONTACT_HREF = 'mailto:hello@townwise.tech';

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
