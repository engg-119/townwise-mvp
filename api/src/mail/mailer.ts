// The mailer handlers call after their write (spec D14): send queues one email and returns at once, so an email never
// delays, fails or retries the action it reports. It logs townwise.email_sent or townwise.email_failed with the kind,
// ids and a code, never the address, subject, body, organization name, town or token. Nothing about a send is stored.
import type { Logger } from '@ckeith26/server-core';
import { z } from 'zod';

import { MailUnavailableError, type MailTransport } from './acs.ts';
import { renderEmail, type RenderedEmail, type TownwiseEmail } from './templates.ts';

/** Ids for the log line only. */
export interface EmailRef {
  readonly requestId: string;
  readonly orgId?: string | undefined;
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
    deps.logger.warn({ kind: email.kind, requestId: ref.requestId, ...(ref.orgId === undefined ? {} : { orgId: ref.orgId }), ...fields }, 'townwise.email_failed');
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
      const ids = { kind: email.kind, requestId: ref.requestId, ...(ref.orgId === undefined ? {} : { orgId: ref.orgId }) };
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
