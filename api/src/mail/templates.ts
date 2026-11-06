// Every word of the two Townwise emails (spec D14). Pure. Subjects are fixed strings: no user text goes in a subject or
// any header. There is no greeting by name (contactName is free text) and no figure of any kind: an email says what
// happened and what comes next, with the organization's name, its town and the address the person signs in with.
import type { Town } from '../towns.ts';
import { htmlLayout, textLayout, type LayoutParts } from './layout.ts';

export type TownwiseEmail =
  | { readonly kind: 'request_received'; readonly orgName: string; readonly town: Town }
  | { readonly kind: 'request_approved'; readonly orgName: string; readonly town: Town };

export type EmailKind = TownwiseEmail['kind'];

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailLinks {
  /** The web app's origin, with no trailing slash: links go to {webUrl}/sign-in and {webUrl}/privacy. */
  readonly webUrl: string;
  /** Whether replies reach a person (TOWNWISE_EMAIL_REPLY_TO is set); the footer says so only then. */
  readonly replies: boolean;
}

export const SUBJECTS: Readonly<Record<EmailKind, string>> = {
  request_received: 'We’ve received your Townwise request',
  request_approved: 'You’re in: welcome to Townwise',
};

function townText(town: Town): string {
  return `${town.name}, ${town.state}`;
}

function parts(email: TownwiseEmail, to: string, links: EmailLinks): LayoutParts {
  const town = townText(email.town);
  const shared = {
    subject: SUBJECTS[email.kind],
    button: { label: 'Open Townwise', href: `${links.webUrl}/sign-in` },
    small: `Sign in with the Google account for ${to}.`,
    footer: 'You’re getting this email because you asked for access to Townwise with this address.'
      + (links.replies ? ' Reply to this email to reach the Townwise team.' : ''),
    footerLinks: [
      { label: 'Townwise' },
      { label: new URL(links.webUrl).host, href: links.webUrl, text: links.webUrl },
      { label: 'Privacy', href: `${links.webUrl}/privacy`, text: `Privacy: ${links.webUrl}/privacy` },
    ],
  };
  switch (email.kind) {
    case 'request_received':
      return {
        ...shared,
        preheader: 'Someone on our team reviews every request by hand.',
        eyebrow: 'REQUEST RECEIVED',
        heading: `We’ve received your request for ${email.orgName}`,
        paragraphs: [
          `Thanks for telling us about ${email.orgName} in ${town}. Someone on the Townwise team reviews every new restaurant by hand, and we’ll email you here as soon as you’re in.`,
          // Until the drop-everything upload and the background reader ship, this promises only today's upload.
          'While you wait, find the sales exports you already have from your point of sale. Once you’re in, you’ll upload your sales history so Townwise can show your town’s busy and quiet days.',
        ],
      };
    case 'request_approved':
      // The first location's name is left out: on a retry it may have been made under another name than this call's.
      return {
        ...shared,
        preheader: `${email.orgName} is set up on Townwise.`,
        eyebrow: 'APPROVED',
        heading: 'You’re in.',
        paragraphs: [
          `We’ve approved your request. ${email.orgName} in ${town} is set up on Townwise, and you’re its admin.`,
          'Next, upload your sales history so Townwise can show your town’s busy and quiet days.',
        ],
      };
  }
}

export function renderEmail(email: TownwiseEmail, to: string, links: EmailLinks): RenderedEmail {
  const layout = parts(email, to, links);
  return { subject: layout.subject, html: htmlLayout(layout), text: textLayout(layout) };
}
