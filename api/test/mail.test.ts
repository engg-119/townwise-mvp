// Townwise's two emails (spec D14): the exact copy, the layout's rules, the ACS transport over a fake fetch, and the
// mailer's never-throw, never-log-the-address contract.
import { createLogger } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import type { AzureTokenSource, FetchLike } from '../src/azure-identity.ts';
import { ACS_API_VERSION, ACS_RESOURCE, createAcsTransport, MailUnavailableError, type MailTransport, type OutboundEmail } from '../src/mail/acs.ts';
import { escapeHtml, MAIL_COLORS } from '../src/mail/layout.ts';
import { createMailer, OFF_MAILER } from '../src/mail/mailer.ts';
import { renderEmail, SUBJECTS, type TownwiseEmail } from '../src/mail/templates.ts';
import type { Town } from '../src/towns.ts';
import { createCapturingTransport } from './helpers/mail.ts';

const WEB_URL = 'https://townwise.test';
const TO = 'person@example.test';
const HANOVER: Town = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
const RECEIVED: TownwiseEmail = { kind: 'request_received', orgName: 'Example Bistro', town: HANOVER };
const APPROVED: TownwiseEmail = { kind: 'request_approved', orgName: 'Example Bistro', town: HANOVER };
const LINKS = { webUrl: WEB_URL, replies: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FOOTER = [
  'You’re getting this email because you asked for access to Townwise with this address. Reply to this email to reach the Townwise team.',
  'Townwise · https://townwise.test · Privacy: https://townwise.test/privacy',
  '',
].join('\n');

describe('templates', () => {
  it('request received: the fixed subject and the exact plain text', () => {
    const email = renderEmail(RECEIVED, TO, LINKS);
    expect(email.subject).toBe('We’ve received your Townwise request');
    expect(email.text).toBe([
      'We’ve received your request for Example Bistro',
      '',
      'Thanks for telling us about Example Bistro in Hanover, NH. Someone on the Townwise team reviews every new restaurant by hand, and we’ll email you here as soon as you’re in.',
      '',
      'While you wait, find the sales exports you already have from your point of sale. Once you’re in, you’ll upload your sales history so Townwise can show your town’s busy and quiet days.',
      '',
      'Open Townwise: https://townwise.test/sign-in',
      'Sign in with the Google account for person@example.test.',
      '',
      FOOTER,
    ].join('\n'));
    expect(email.html).toContain('Someone on our team reviews every request by hand.');
    expect(email.html).toContain('REQUEST RECEIVED');
  });

  it('you’re in: the fixed subject and the exact plain text, which never names the first location', () => {
    const email = renderEmail(APPROVED, TO, LINKS);
    expect(email.subject).toBe('You’re in: welcome to Townwise');
    expect(email.text).toBe([
      'You’re in.',
      '',
      'We’ve approved your request. Example Bistro in Hanover, NH is set up on Townwise, and you’re its admin.',
      '',
      'Next, upload your sales history so Townwise can show your town’s busy and quiet days.',
      '',
      'Open Townwise: https://townwise.test/sign-in',
      'Sign in with the Google account for person@example.test.',
      '',
      FOOTER,
    ].join('\n'));
    expect(email.html).toContain('Example Bistro is set up on Townwise.');
    expect(email.html).toContain('APPROVED');
  });

  it('only two subjects exist, and no user text reaches one', () => {
    expect(Object.keys(SUBJECTS).sort()).toEqual(['request_approved', 'request_received']);
    const sneaky = renderEmail({ ...RECEIVED, orgName: 'Sentinel\r\nBcc: other@example.test' }, TO, LINKS);
    expect(sneaky.subject).toBe(SUBJECTS.request_received);
  });

  it('without a Reply-To, the footer does not offer replies', () => {
    const email = renderEmail(RECEIVED, TO, { webUrl: WEB_URL, replies: false });
    expect(email.text).not.toContain('Reply to this email');
    expect(email.html).not.toContain('Reply to this email');
    expect(email.text).toContain('You’re getting this email because you asked for access to Townwise with this address.\n');
  });

  it('escapes user text in the HTML and keeps it verbatim in the text part', () => {
    const orgName = '<b>"Bistro" & Co\'s</b><script>alert(1)</script>';
    for (const kind of ['request_received', 'request_approved'] as const) {
      const email = renderEmail({ kind, orgName, town: { townId: null, name: 'Smallville <i>', state: 'VT' } }, TO, LINKS);
      expect(email.html).toContain(escapeHtml(orgName));
      expect(email.html).toContain('&lt;b&gt;&quot;Bistro&quot; &amp; Co&#39;s&lt;/b&gt;');
      expect(email.html).not.toContain('<b>');
      expect(email.html).not.toContain('<i>');
      expect(email.text).toContain(orgName);
      expect(email.text).toContain('Smallville <i>, VT');
    }
  });
});

describe('layout', () => {
  const emails = [renderEmail(RECEIVED, TO, LINKS), renderEmail(APPROVED, TO, LINKS)];

  it('is a dark, declared-dark document titled with the subject', () => {
    for (const email of emails) {
      expect(email.html.startsWith('<!doctype html>')).toBe(true);
      expect(email.html).toContain('<html lang="en" dir="ltr" style="color-scheme:dark">');
      expect(email.html).toContain('<meta charset="utf-8">');
      expect(email.html).toContain('<meta name="color-scheme" content="dark">');
      expect(email.html).toContain('<meta name="supported-color-schemes" content="dark">');
      expect(email.html).toContain(`<title>${escapeHtml(email.subject)}</title>`);
      // The preheader is the first thing in the body.
      expect(email.html).toMatch(/<body[^>]*>\n<div style="display:none;[^"]*">[^<]+<\/div>/);
    }
  });

  it('has no image, style sheet, script, form or font load, so nothing can track an open', () => {
    for (const email of emails) {
      for (const banned of ['<img', '<style', '<link', '<script', '<form', '<iframe', '@import', 'url(', 'background-image', '@font-face']) {
        expect(email.html.toLowerCase()).not.toContain(banned);
      }
    }
  });

  it('links only to the web app, with no tracking parameters, and the button goes to sign-in', () => {
    for (const email of emails) {
      const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs.sort()).toEqual([WEB_URL, `${WEB_URL}/privacy`, `${WEB_URL}/sign-in`]);
      expect(email.html).not.toMatch(/utm_|\?/);
    }
  });

  it('uses only the theme colors, with mint as the one accent cell and a white button', () => {
    const allowed = new Set<string>(Object.values(MAIL_COLORS));
    for (const email of emails) {
      const colors = new Set(email.html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []);
      for (const color of colors) expect(allowed).toContain(color);
      expect(email.html.match(new RegExp(MAIL_COLORS.mint, 'g'))).toHaveLength(1);
      expect(email.html).toContain(`<td bgcolor="${MAIL_COLORS.white}"`);
      expect(email.html).toContain(`color:${MAIL_COLORS.ground};text-decoration:none">Open Townwise</a>`);
    }
  });

  it('is under 20 KB and leaves no placeholder in either part', () => {
    for (const email of emails) {
      expect(Buffer.byteLength(email.html, 'utf8')).toBeLessThan(20 * 1024);
      for (const part of [email.html, email.text]) expect(part).not.toMatch(/\{[a-zA-Z]+\}|\$\{|undefined|null/);
    }
  });
});

interface FetchCall { url: string; init: RequestInit }

function fakeTokens(): AzureTokenSource & { invalidated: string[]; asked: string[] } {
  const invalidated: string[] = [];
  const asked: string[] = [];
  return {
    invalidated,
    asked,
    getToken: (resource) => {
      asked.push(resource);
      return Promise.resolve({ token: 'test-bearer-token', expiresOnTimestamp: 0 });
    },
    invalidate: (resource) => { invalidated.push(resource); },
  };
}

function acs(answer: () => Response | Promise<Response>, tokens: AzureTokenSource = fakeTokens()): { transport: MailTransport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(answer());
  };
  return {
    calls,
    transport: createAcsTransport({ endpoint: 'https://acs-test.unitedstates.communication.azure.com', sender: 'no-reply@townwise.test', tokens, fetch }),
  };
}

const MESSAGE: OutboundEmail = { to: TO, replyTo: 'team@townwise.test', subject: 'Subject', html: '<p>html</p>', text: 'text' };

async function mailFailureOf(run: () => Promise<unknown>): Promise<MailUnavailableError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(MailUnavailableError);
    return err as MailUnavailableError;
  }
  return expect.unreachable();
}

describe('ACS transport', () => {
  it('posts one message to emails:send with a bearer token for Communication Services, tracking off', async () => {
    const tokens = fakeTokens();
    const { transport, calls } = acs(() => new Response('{"id":"x","status":"Running"}', { status: 202 }), tokens);
    await transport.send(MESSAGE);
    expect(calls).toHaveLength(1);
    expect(ACS_API_VERSION).toBe('2023-03-31');
    expect(calls[0]?.url).toBe('https://acs-test.unitedstates.communication.azure.com/emails:send?api-version=2023-03-31');
    expect(tokens.asked).toEqual([ACS_RESOURCE]);
    expect(ACS_RESOURCE).toBe('https://communication.azure.com');
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-bearer-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('operation-id')).toMatch(UUID);
    expect(headers.get('x-ms-client-request-id')).toMatch(UUID);
    expect(JSON.parse(init?.body as string)).toEqual({
      senderAddress: 'no-reply@townwise.test',
      recipients: { to: [{ address: TO }] },
      replyTo: [{ address: 'team@townwise.test', displayName: 'Townwise' }],
      content: { subject: 'Subject', plainText: 'text', html: '<p>html</p>' },
      userEngagementTrackingDisabled: true,
    });
  });

  it('omits replyTo when there is none', async () => {
    const { transport, calls } = acs(() => new Response(null, { status: 202 }));
    await transport.send({ ...MESSAGE, replyTo: null });
    expect(JSON.parse(calls[0]?.init.body as string)).not.toHaveProperty('replyTo');
  });

  it('any status but 202 is upstream_status with the status and a well-formed x-ms-error-code, never the body', async () => {
    for (const [status, code, expected] of [
      [401, 'InvalidAuthenticationToken', 'InvalidAuthenticationToken'],
      [429, 'TooManyRequests', 'TooManyRequests'],
      [500, 'has spaces in it', null],
      [400, 'x'.repeat(65), null],
      [200, null, null],
    ] as const) {
      const headers: Record<string, string> = code === null ? {} : { 'x-ms-error-code': code };
      const { transport } = acs(() => new Response(`{"error":{"message":"bad recipient ${TO}"}}`, { status, headers }));
      const err = await mailFailureOf(() => transport.send(MESSAGE));
      expect({ code: err.code, status: err.status, upstreamCode: err.upstreamCode }).toEqual({ code: 'upstream_status', status, upstreamCode: expected });
      expect(String(err)).not.toContain(TO);
      expect(JSON.stringify(err)).not.toContain(TO);
    }
  });

  it('a refusal drops the cached token so the next email gets a new one; an accepted send keeps it', async () => {
    const tokens = fakeTokens();
    let status = 401;
    const { transport } = acs(() => new Response(null, { status }), tokens);
    await mailFailureOf(() => transport.send(MESSAGE));
    expect(tokens.invalidated).toEqual([ACS_RESOURCE]);
    status = 202;
    await transport.send(MESSAGE);
    expect(tokens.invalidated).toEqual([ACS_RESOURCE]);
  });

  it('a timeout, a thrown fetch and a missing token each have their own code', async () => {
    const timeout = acs(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    expect((await mailFailureOf(() => timeout.transport.send(MESSAGE))).code).toBe('timeout');
    const network = acs(() => Promise.reject(new TypeError('fetch failed')));
    const err = await mailFailureOf(() => network.transport.send(MESSAGE));
    expect({ code: err.code, errType: err.errType }).toEqual({ code: 'network', errType: 'TypeError' });
    const noToken: AzureTokenSource = { getToken: () => Promise.reject(new Error('no identity')), invalidate: () => undefined };
    const token = acs(() => new Response(null, { status: 202 }), noToken);
    expect((await mailFailureOf(() => token.transport.send(MESSAGE))).code).toBe('token');
    expect(token.calls).toHaveLength(0);
  });
});

function capturedLogger(): { logger: ReturnType<typeof createLogger>; lines: () => Record<string, unknown>[]; raw: () => string } {
  const logs: string[] = [];
  const logger = createLogger({ LOG_LEVEL: 'trace' }, {
    destination: { write: (message: string) => { logs.push(...message.split('\n').filter((line) => line.trim() !== '')); } },
  });
  return { logger, raw: () => logs.join('\n'), lines: () => logs.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const LOG_KEYS = ['kind', 'requestId', 'orgId', 'code', 'status', 'upstreamCode', 'errType'];

describe('mailer', () => {
  const REF = { requestId: '000000000000000000000001', orgId: '000000000000000000000002' };

  it('queues, returns undefined at once, sends the rendered email with Reply-To and logs townwise.email_sent with ids only', async () => {
    const transport = createCapturingTransport();
    const log = capturedLogger();
    const mailer = createMailer({ transport, logger: log.logger, webUrl: WEB_URL, replyTo: 'team@townwise.test' });
    const held = transport.hold();
    mailer.send(APPROVED, TO, REF);
    expect(transport.sent).toHaveLength(1);
    expect(log.lines().filter((l) => String(l.msg).startsWith('townwise.email'))).toEqual([]);
    let idle = false;
    const waiting = mailer.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    held.release();
    await waiting;
    expect(transport.sent[0]).toEqual({ to: TO, replyTo: 'team@townwise.test', ...renderEmail(APPROVED, TO, LINKS) });
    const sent = log.lines().filter((l) => l.msg === 'townwise.email_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'request_approved', ...REF });
  });

  it('a failure logs townwise.email_failed with a code and allowlisted keys, never the address, name or error text', async () => {
    const transport = createCapturingTransport();
    const log = capturedLogger();
    const mailer = createMailer({ transport, logger: log.logger, webUrl: WEB_URL, replyTo: null });
    transport.failNext(1, new MailUnavailableError('upstream_status', { status: 429, upstreamCode: 'TooManyRequests' }));
    transport.failNext(1, new Error(`sentinel error text ${TO}`));
    mailer.send({ ...RECEIVED, orgName: 'Sentinel Org' }, TO, { requestId: REF.requestId });
    mailer.send({ ...RECEIVED, orgName: 'Sentinel Org' }, TO, { requestId: REF.requestId });
    await mailer.idle();
    const failed = log.lines().filter((l) => l.msg === 'townwise.email_failed');
    expect(failed.map((l) => [l.code, l.status, l.upstreamCode])).toEqual([['upstream_status', 429, 'TooManyRequests'], ['internal', undefined, undefined]]);
    for (const line of failed) {
      const keys = Object.keys(line).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key));
      for (const key of keys) expect(LOG_KEYS).toContain(key);
    }
    for (const secret of [TO, 'Sentinel Org', 'sentinel error text', 'Hanover']) expect(log.raw()).not.toContain(secret);
  });

  it('never throws, even when the transport throws before returning a promise', async () => {
    const log = capturedLogger();
    const throwing: MailTransport = { send: () => { throw new Error('sync'); } };
    const mailer = createMailer({ transport: throwing, logger: log.logger, webUrl: WEB_URL, replyTo: null });
    expect(() => { mailer.send(RECEIVED, TO, REF); }).not.toThrow();
    await mailer.idle();
    expect(log.lines().filter((l) => l.msg === 'townwise.email_failed').map((l) => l.code)).toEqual(['internal']);
  });

  it('an address that is not an email logs invalid_recipient and sends nothing', async () => {
    const transport = createCapturingTransport();
    const log = capturedLogger();
    const mailer = createMailer({ transport, logger: log.logger, webUrl: WEB_URL, replyTo: null });
    mailer.send(RECEIVED, 'not-an-address', REF);
    await mailer.idle();
    expect(transport.sent).toEqual([]);
    expect(log.lines().filter((l) => l.msg === 'townwise.email_failed').map((l) => l.code)).toEqual(['invalid_recipient']);
    expect(log.raw()).not.toContain('not-an-address');
  });

  it('OFF_MAILER sends nothing and is always idle', async () => {
    OFF_MAILER.send(RECEIVED, TO, REF);
    await expect(OFF_MAILER.idle()).resolves.toBeUndefined();
  });
});
