// The statement moments' words (spec 15.8). Pure. Apostrophes are U+2019; no exclamation marks, no em dashes.
// The copy says only what is true now: the follow line of the request moment repeats the held page's own sentence,
// so it stays true whether or not the approval email has shipped.

import type { AccessState, MeResponse } from '../schemas';

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

export type MomentKind = 'request_received' | 'welcome';

/** A moment the provider decided to play: `key` names it, so it plays once in a session. */
export interface Moment {
  key: string;
  kind: MomentKind;
  statement: Statement;
}

/** The states that may send an access request (spec 10.2). */
const MAY_REQUEST: ReadonlySet<AccessState> = new Set<AccessState>(['no_org', 'rejected', 'removed']);

/**
 * Which moment a new GET /api/me answer (or an answer applied in its place) plays, if any. Never under view-as.
 * - Request received: this session saw the access go from a state that may request to `pending`, so a fresh load
 *   of the held page plays nothing. Keyed by the request, so a new request after a rejection plays again.
 * - Welcome: the person is a member and the server says the welcome is due (it answers null once recorded).
 */
export function momentFor(previous: MeResponse | null, next: MeResponse, played: ReadonlySet<string>): Moment | null {
  if (next.viewAs !== null) return null;
  const { access } = next;
  let moment: Moment | null = null;
  if (access.state === 'pending') {
    // A fresh load (no previous answer) plays nothing, and neither does an answer that followed a view-as.
    if (previous === null) return null;
    if (previous.viewAs !== null || !MAY_REQUEST.has(previous.access.state)) return null;
    moment = {
      key: `received:${access.request.id}`, kind: 'request_received', statement: requestReceivedStatement(access.request.orgName),
    };
  } else if (access.state === 'member' && next.welcome != null) {
    moment = { key: `welcome:${next.user.id}:${access.org.id}`, kind: 'welcome', statement: welcomeStatement(next.welcome) };
  }
  if (moment === null) return null;
  return played.has(moment.key) ? null : moment;
}
