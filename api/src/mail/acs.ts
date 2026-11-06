// Azure Communication Services Email - Send (api-version 2023-03-31) over fetch, as a port: main.ts builds it when
// EMAIL_ENDPOINT is set, tests use helpers/mail.ts. It authenticates with the managed identity's Entra token, the only
// way in: infra/terraform/production/email.tf disables access keys. Nothing here logs.
// ACS error bodies can echo the recipient, so a body is never read into an error: a failure is a MailUnavailableError
// with a code, the HTTP status and ACS's x-ms-error-code when it looks like a code.
import { randomUUID } from 'node:crypto';

import { AzureIdentityError, type AzureTokenSource, type FetchLike } from '../azure-identity.ts';

export const ACS_API_VERSION = '2023-03-31';
/** The Entra resource for Communication Services data-plane calls (the SDKs' scope https://communication.azure.com//.default). */
export const ACS_RESOURCE = 'https://communication.azure.com';
/** One send, from the request to the response headers. */
export const MAIL_TIMEOUT_MS = 10_000;

export interface OutboundEmail {
  readonly to: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailTransport {
  /** Resolves when ACS accepted the message (202). Throws MailUnavailableError. */
  send(message: OutboundEmail): Promise<void>;
}

/** `token`: the managed identity gave no token. `upstream_status`: ACS answered something other than 202. */
export type MailFailure = 'token' | 'timeout' | 'network' | 'upstream_status';

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export class MailUnavailableError extends Error {
  readonly code: MailFailure;
  /** ACS's HTTP status, or the token endpoint's for `token`. */
  readonly status: number | null;
  /** ACS's x-ms-error-code, only when it matches /^[A-Za-z0-9_.-]{1,64}$/. */
  readonly upstreamCode: string | null;
  /** The error class, for `network`. */
  readonly errType: string | null;

  constructor(code: MailFailure, opts?: { status?: number | null; upstreamCode?: string | null; errType?: string | null }) {
    super('Email is unavailable');
    this.name = 'MailUnavailableError';
    this.code = code;
    this.status = opts?.status ?? null;
    this.upstreamCode = opts?.upstreamCode ?? null;
    this.errType = opts?.errType ?? null;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** No retries and no status polling: nothing would be done with the answer. */
export function createAcsTransport(deps: {
  /** https://<resource>.communication.azure.com, a bare origin (config.ts checks it). */
  endpoint: string;
  /** The From address, a sender username on the verified domain. */
  sender: string;
  tokens: AzureTokenSource;
  fetch?: FetchLike;
  timeoutMs?: number;
}): MailTransport {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? MAIL_TIMEOUT_MS;
  const url = `${deps.endpoint}/emails:send?api-version=${ACS_API_VERSION}`;

  return {
    send: async (message) => {
      let token: string;
      try {
        token = (await deps.tokens.getToken(ACS_RESOURCE)).token;
      } catch (err) {
        throw new MailUnavailableError('token', { status: err instanceof AzureIdentityError ? err.status : null });
      }
      const body = {
        senderAddress: deps.sender,
        // No displayName: that would be more user text in a header.
        recipients: { to: [{ address: message.to }] },
        ...(message.replyTo === null ? {} : { replyTo: [{ address: message.replyTo, displayName: 'Townwise' }] }),
        content: { subject: message.subject, plainText: message.text, html: message.html },
        // Also off on the domain (email.tf): links are never rewritten through a tracking redirector.
        userEngagementTrackingDisabled: true,
      };
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Operation-Id': randomUUID(),
            'x-ms-client-request-id': randomUUID(),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (isTimeout(err)) throw new MailUnavailableError('timeout');
        throw new MailUnavailableError('network', { errType: err instanceof Error ? err.constructor.name : typeof err });
      }
      if (res.body !== null) await res.body.cancel().catch(() => undefined);
      if (res.status === 202) return;
      // Any refusal drops the cached token, so a stale or revoked one never sticks: the next email fetches a new one.
      // This one is not retried.
      deps.tokens.invalidate(ACS_RESOURCE);
      const upstream = res.headers.get('x-ms-error-code');
      throw new MailUnavailableError('upstream_status', {
        status: res.status,
        upstreamCode: upstream !== null && ERROR_CODE.test(upstream) ? upstream : null,
      });
    },
  };
}
