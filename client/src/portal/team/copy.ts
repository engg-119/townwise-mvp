import type { AddOutcome } from './api';

// Team copy (spec P17, the Members board) and the address list the Add form sends (F5 step 1). Settings (P18)
// reuses the last-admin line.

/** Spec 18: at most 20 addresses per add. */
export const MAX_EMAILS = 20;

/** Spec 10.6: each address up to 320 characters. The server refuses the whole request for one longer. */
export const MAX_EMAIL_LENGTH = 320;

export const TEAM_COPY = {
  loading: 'Loading your team',
  lead: 'Each person signs in with “Continue with Google” using the exact address you add here. Townwise accepts '
    + 'Gmail addresses and Google Workspace accounts. We don’t send invitations yet, so let them know yourself.',
  emailsHelper: 'One per line or separated by commas, up to 20.',
  roleHelper: 'Everyone you add at once gets this role. You can change it on any row below.',
  noEmails: 'Enter at least one email address.',
  tooMany: 'Add up to 20 addresses at a time.',
  tooLong: 'Each address can be up to 320 characters.',
  empty: 'It’s just you so far. Add your teammates’ email addresses, and they can join the next time they continue with Google.',
  lastAdmin: 'Your organization needs at least one admin. Make someone else an admin first.',
  memberLimit: 'Your organization has reached 200 people.',
  notFound: 'This team member isn’t available.',
  saved: 'Saved.',
  removeBody: 'They lose access on their next visit. Their notes and uploads stay.',
} as const;

export const OUTCOME_COPY: Readonly<Record<AddOutcome, string>> = {
  invited: 'Added. They can join the next time they continue with Google.',
  already_invited: 'Already invited.',
  already_member: 'Already on your team.',
  invalid: 'That isn’t an email address.',
};

export function addPeopleIntro(org: string): string {
  return `An address you add works the first time that person continues with Google. They join ${org} with the role you pick, `
    + 'with nothing to accept and no approval step.';
}

export function removedLine(email: string): string {
  return `Removed ${email}. They lose access on their next visit.`;
}

export function uninvitedLine(email: string): string {
  return `Removed the invitation for ${email}.`;
}

export function uninviteBody(org: string): string {
  return `That address no longer joins ${org} when it continues with Google. You can add it again later.`;
}

/**
 * The addresses in the textarea: split on new lines and commas (and spaces or semicolons, which no address
 * contains), trimmed, with repeats dropped ignoring case. The server normalizes and validates each one; this only
 * keeps the request within its 1 to 20 entries of up to 320 characters.
 */
export function parseEmails(text: string): { emails: string[] } | { message: string } {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const key = part.toLowerCase();
    if (part === '' || seen.has(key)) continue;
    seen.add(key);
    emails.push(part);
  }
  if (emails.length === 0) return { message: TEAM_COPY.noEmails };
  if (emails.length > MAX_EMAILS) return { message: TEAM_COPY.tooMany };
  if (emails.some((email) => email.length > MAX_EMAIL_LENGTH)) return { message: TEAM_COPY.tooLong };
  return { emails };
}
