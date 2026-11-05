import type { MagicLinkMessage } from '@ckeith26/auth';
import type { ServerConfig } from '@ckeith26/server-core';

/**
 * Townwise signs in with Google only, but @ckeith26/auth always mounts the magic-link routes and
 * requires a sender. When the sender rejects, POST /auth/magic-link answers 503 email_unavailable
 * and nothing is delivered (api/kit/auth/src/magic-link.ts, requestLink).
 *
 * TODO(human): decide what a magic-link request does in each environment. Options:
 *  - Always reject (what the placeholder below does): one behavior everywhere, and nobody can
 *    sign in locally until a Google OAuth client exists.
 *  - Development appends message.url to the gitignored `.magic-links` file (the dev writer in
 *    api/kit/auth/MODULE.md), production rejects: teammates can sign in locally before Google is
 *    set up, at the cost of a code path that exists only outside production.
 *  - Resolve without sending: the client shows "check your email" and nothing arrives. Avoid.
 * Never log message.url or write it to stdout: it is a sign-in credential.
 */
export function createSendMagicLink(config: Pick<ServerConfig, 'NODE_ENV'>): (message: MagicLinkMessage) => Promise<void> {
  return () => Promise.reject(new Error(`TODO(human): magic-link delivery for NODE_ENV=${config.NODE_ENV}`));
}
