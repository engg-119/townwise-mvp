// The statement moments' words (spec 15.8). Pure. Apostrophes are U+2019; no exclamation marks, no em dashes.
// The copy says only what is true now: the follow line of the request moment repeats the held page's own sentence,
// so it stays true whether or not the approval email has shipped.

export interface Statement {
  /** White, revealed first. */
  lead: string;
  /** text2, under the lead. */
  follow: string;
}

/** What GET /api/me answers on the first visit after approval (spec 10.1). */
export interface WelcomeView {
  /** Null for an honorific, an initial or a long token: the welcome then has no name. */
  firstName: string | null;
  /** The organization's current name. */
  restaurant: string;
}

/** Ends `text` with a full stop unless it already ends a sentence (“Lou’s Inc.” stays as it is). */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Plays right after the access request is sent. `orgName` is the request's organization name. */
export function requestReceivedStatement(orgName: string): Statement {
  return { lead: sentence(`We’ve received your request for ${orgName.trim()}`), follow: 'We’ll let you in soon.' };
}

/** Plays on the first visit after approval. */
export function welcomeStatement(welcome: WelcomeView): Statement {
  const name = welcome.firstName?.trim() ?? '';
  return {
    lead: name === '' ? 'Welcome to Townwise.' : sentence(`Welcome to Townwise, ${name}`),
    follow: `${welcome.restaurant.trim()}, ready to set up.`,
  };
}

/** What a screen reader hears, once: the whole statement as plain text. */
export function spokenStatement(statement: Statement): string {
  return `${statement.lead} ${statement.follow}`;
}
