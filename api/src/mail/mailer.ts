// The mailer callers use after their write (spec D14): send queues one email and returns at once, so an email never
// delays, fails or retries the action it reports. Townwise sends three emails: request_received and request_approved,
// each to the person who asked for access, and first_forecast, to every org admin of an organization once per location
// (mail/first-forecast.ts). It logs townwise.email_sent or townwise.email_failed with the kind, the ids present and a
// code, never the address, subject, body, organization or location name, town or token. The mailer stores nothing; the
// only trace of a send outside the log is the date a location's first-forecast email was sent, kept on the location
// (tw_locations.firstForecastMailedAt) so it goes once.
import type { Logger } from '@ckeith26/server-core';
import { z } from 'zod';

import { MailUnavailableError, type MailTransport } from './acs.ts';
import { renderEmail, type RenderedEmail, type TownwiseEmail } from './templates.ts';

/** Ids for the log line only: the access request's for the access emails, the organization's and location's for the first forecast. */
export interface EmailRef {
  readonly requestId?: string | undefined;
  readonly orgId?: string | undefined;
  readonly locationId?: string | undefined;
}

/** The ref's ids that are present, for a log line. */
function refIds(ref: EmailRef): Record<string, string> {
  return {
    ...(ref.requestId === undefined ? {} : { requestId: ref.requestId }),
    ...(ref.orgId === undefined ? {} : { orgId: ref.orgId }),
    ...(ref.locationId === undefined ? {} : { locationId: ref.locationId }),
  };
}

export interface Mailer {
  /** Queues one email to `to` and returns at once. Never throws, never retries, never logs the address. */
  send(email: TownwiseEmail, to: string, ref: EmailRef): void;
  /** Resolves when every queued send has settled: for tests, and the shutdown drain. */
  idle(): Promise<void>;
}

/** Email off (EMAIL_ENDPOINT unset): nothing is sent or logged. */
export const OFF_MAILER: Mailer = {
  send: () => undefined,
  idle: () => Promise.resolve(),
};

const recipient = z.email();

export function createMailer(deps: {
  transport: MailTransport;
  logger: Logger;
  /** The web app's origin, with no trailing slash. */
  webUrl: string;
  replyTo: string | null;
}): Mailer {
  const inFlight = new Set<Promise<void>>();

  const failed = (email: TownwiseEmail, ref: EmailRef, fields: Record<string, unknown>): void => {
    deps.logger.warn({ kind: email.kind, ...refIds(ref), ...fields }, 'townwise.email_failed');
  };

  return {
    send: (email, to, ref) => {
      if (!recipient.safeParse(to).success) {
        failed(email, ref, { code: 'invalid_recipient' });
        return;
      }
      let rendered: RenderedEmail;
      try {
        rendered = renderEmail(email, to, { webUrl: deps.webUrl, replies: deps.replyTo !== null });
      } catch {
        failed(email, ref, { code: 'render' });
        return;
      }
      let started: Promise<void>;
      try {
        started = deps.transport.send({ to, replyTo: deps.replyTo, ...rendered });
      } catch (err) {
        started = Promise.reject(err instanceof Error ? err : new Error('transport threw'));
      }
      const ids = { kind: email.kind, ...refIds(ref) };
      const settled = started.then(
        () => { deps.logger.info(ids, 'townwise.email_sent'); },
        (err: unknown) => {
          // The error itself, its message and any body never reach the log.
          if (err instanceof MailUnavailableError) {
            failed(email, ref, { code: err.code, status: err.status, upstreamCode: err.upstreamCode, errType: err.errType });
          } else {
            failed(email, ref, { code: 'internal' });
          }
        },
      ).finally(() => inFlight.delete(settled));
      inFlight.add(settled);
    },
    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
