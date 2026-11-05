import { expect, test } from 'vitest';

import { hashToken } from '../src/sessions.ts';
import { call, WEB_ORIGIN } from './helpers/http.ts';
import { parseLink } from './helpers/mail.ts';
import { startAuthServer, type AuthTestServer } from './helpers/server.ts';

const EMAIL = 'ada@example.test';

async function withServer(
  run: (server: AuthTestServer) => Promise<void>,
  opts?: Parameters<typeof startAuthServer>[0],
): Promise<void> {
  const server = await startAuthServer(opts);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function web(server: AuthTestServer, path: string, json: unknown): Promise<Response> {
  return call(server.url, path, { json, origin: WEB_ORIGIN });
}

function native(server: AuthTestServer, path: string, json: unknown): Promise<Response> {
  return call(server.url, path, { json });
}

async function requestLink(server: AuthTestServer, email: string, platform: 'web' | 'native' = 'web'): Promise<Response> {
  const json = { email, platform };
  return platform === 'web'
    ? web(server, '/auth/magic-link', json)
    : native(server, '/auth/magic-link', json);
}

async function errorOf(res: Response): Promise<string | undefined> {
  const body = await res.json() as { error?: string };
  return body.error;
}

test('known and unknown emails get byte-identical responses', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
    const known = await requestLink(server, EMAIL);
    const unknown = await requestLink(server, 'nobody@example.test');
    expect(known.status).toBe(unknown.status);
    expect(Buffer.from(await known.arrayBuffer())).toEqual(Buffer.from(await unknown.arrayBuffer()));
    expect([...known.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
  });
});

test('stores only the SHA-256 of the token', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const docs = await server.connection.collection('auth_magic_links').find().toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]?._id).toBe(hashToken(token));
    expect(JSON.stringify(docs)).not.toContain(token);
  });
});

test('the link carries the token in the fragment only', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const url = server.mail.messages[0]?.url ?? '';
    expect(url.slice(0, url.indexOf('#'))).toBe(server.env.AUTH_MAGIC_LINK_URL);
    expect(parseLink(url).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

test('the link fragment carries the normalized email', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, '  Ada@Example.Test ')).status).toBe(202);
    expect(parseLink(server.mail.messages[0]?.url ?? '').email).toBe(EMAIL);
  });
});

test('GET on the redeem path does not consume the token', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const got = await call(server.url, '/auth/magic-link/redeem', { method: 'GET', origin: WEB_ORIGIN });
    expect(got.status).toBe(404);
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
  });
});

test('one token redeems exactly once under 5 concurrent POSTs', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const responses = await Promise.all(Array.from({ length: 5 }, () => web(server, '/auth/magic-link/redeem', {
      token,
      email: EMAIL,
      platform: 'web',
    })));
    const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(4);
    for (const res of responses) {
      if (res.status !== 400) continue;
      expect(await errorOf(res)).toBe('invalid_or_expired_link');
    }
    expect(await server.connection.collection('auth_sessions').countDocuments()).toBe(1);
  });
});

test('a redeem whose email does not match consumes nothing', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const wrong = await web(server, '/auth/magic-link/redeem', { token, email: 'bea@example.test', platform: 'web' });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe('invalid_or_expired_link');
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
  });
});

test('a link requested on web cannot be redeemed as native and stays redeemable on web', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL, 'web')).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const nativeTry = await native(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'native' });
    expect(nativeTry.status).toBe(400);
    expect(await errorOf(nativeTry)).toBe('invalid_or_expired_link');
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
  });
});

test('an expired token is refused', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    server.clock.advance(15 * 60 * 1000 + 1000);
    const res = await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('invalid_or_expired_link');
  });
});

test('first redemption for a new email creates the user and reports isNewUser', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const first = parseLink(server.mail.messages[0]?.url ?? '').token;
    const created = await web(server, '/auth/magic-link/redeem', { token: first, email: EMAIL, platform: 'web' });
    const createdBody = await created.json() as { status: string; isNewUser: boolean; user: { email: string } };
    expect(created.status).toBe(200);
    expect(createdBody).toMatchObject({ status: 'signed_in', isNewUser: true, user: { email: EMAIL } });
    expect(createdBody).not.toHaveProperty('accessToken');
    expect(await server.stores.users.findByEmail(EMAIL)).not.toBeNull();
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const second = parseLink(server.mail.messages[1]?.url ?? '').token;
    const again = await web(server, '/auth/magic-link/redeem', { token: second, email: EMAIL, platform: 'web' });
    expect(await again.json()).toMatchObject({ status: 'signed_in', isNewUser: false });
  });
});

test('a new request invalidates the email\'s previous link', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const first = parseLink(server.mail.messages[0]?.url ?? '').token;
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const second = parseLink(server.mail.messages[1]?.url ?? '').token;
    const stale = await web(server, '/auth/magic-link/redeem', { token: first, email: EMAIL, platform: 'web' });
    expect(stale.status).toBe(400);
    expect((await web(server, '/auth/magic-link/redeem', { token: second, email: EMAIL, platform: 'web' })).status).toBe(200);
  });
});

test('redeeming deletes the email\'s other pending links', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const now = server.clock.now();
    await server.stores.magicLinks.create({
      tokenHash: 'other-pending',
      email: EMAIL,
      platform: 'native',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
    expect(await server.stores.magicLinks.consume({
      tokenHash: 'other-pending',
      email: EMAIL,
      platform: 'native',
      now: server.clock.now(),
    })).toBe(false);
  });
});

test('redemption resets the per-email send limit', async () => {
  await withServer(async (server) => {
    for (let sent = 0; sent < 3; sent += 1) {
      expect((await requestLink(server, EMAIL)).status).toBe(202);
    }
    const token = parseLink(server.mail.messages[2]?.url ?? '').token;
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
    expect((await requestLink(server, EMAIL)).status).toBe(202);
  });
});

test('the 4th request for one email within 15 minutes is 429', async () => {
  await withServer(async (server) => {
    for (let sent = 0; sent < 3; sent += 1) {
      expect((await requestLink(server, EMAIL)).status).toBe(202);
    }
    const limited = await requestLink(server, EMAIL);
    const body = await limited.json() as { error?: string; retryAfterSeconds?: number };
    expect(limited.status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterSeconds).toEqual(expect.any(Number));
    expect(limited.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
  });
});

test('a non-string token is 400 and consumes nothing', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const bad = await web(server, '/auth/magic-link/redeem', { token: 42, email: EMAIL, platform: 'web' });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toBe('invalid_request');
    expect((await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' })).status).toBe(200);
  });
});

test('successful sign-ins to the attacker\'s own account never reset an IP rule', async () => {
  await withServer(async (server) => {
    const bad = { token: 'a'.repeat(43), email: EMAIL, platform: 'native' as const };
    for (let hit = 0; hit < 117; hit += 1) {
      expect((await native(server, '/auth/magic-link/redeem', bad)).status).toBe(400);
    }
    for (let signed = 0; signed < 3; signed += 1) {
      const email = `user${String(signed)}@example.test`;
      expect((await requestLink(server, email, 'native')).status).toBe(202);
      const token = parseLink(server.mail.messages[signed]?.url ?? '').token;
      expect((await native(server, '/auth/magic-link/redeem', { token, email, platform: 'native' })).status).toBe(200);
    }
    const limited = await native(server, '/auth/magic-link/redeem', bad);
    expect(limited.status).toBe(429);
    expect(await errorOf(limited)).toBe('rate_limited');
  });
});

test('the redeem route is rate limited by auth:ip', async () => {
  await withServer(async (server) => {
    const bad = { token: 'b'.repeat(43), email: EMAIL, platform: 'native' as const };
    for (let hit = 0; hit < 120; hit += 1) {
      expect((await native(server, '/auth/magic-link/redeem', bad)).status).toBe(400);
    }
    const limited = await native(server, '/auth/magic-link/redeem', bad);
    expect(limited.status).toBe(429);
    expect(await errorOf(limited)).toBe('rate_limited');
  });
});

test('503 email_unavailable when sendMagicLink throws', async () => {
  await withServer(async (server) => {
    server.mail.failNext();
    const res = await requestLink(server, EMAIL);
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('email_unavailable');
  });
});

test('a throwing onUserCreated is logged and the new user is still signed in', async () => {
  await withServer(async (server) => {
    expect((await requestLink(server, EMAIL)).status).toBe(202);
    const token = parseLink(server.mail.messages[0]?.url ?? '').token;
    const res = await web(server, '/auth/magic-link/redeem', { token, email: EMAIL, platform: 'web' });
    const body = await res.json() as { status: string; isNewUser: boolean; user: { id: string } };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'signed_in', isNewUser: true });
    const failed = server.logs.flatMap((line) => {
      const parsed = JSON.parse(line) as { msg?: string; userId?: string };
      return parsed.msg === 'auth.on_user_created_failed' ? [parsed] : [];
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.userId).toBe(body.user.id);
  }, {
    deps: { onUserCreated: () => Promise.reject(new Error('hook failed')) },
  });
});

test('array-valued token, email and code fields are 400', async () => {
  await withServer(async (server) => {
    const redeem = await call(server.url, '/auth/magic-link/redeem', {
      json: { token: ['not-a-token'], email: [EMAIL], platform: 'web' },
      origin: WEB_ORIGIN,
    });
    expect(redeem.status).toBe(400);
    expect(await redeem.json()).toMatchObject({ error: 'invalid_request' });
    const mfa = await call(server.url, '/auth/mfa/verify', {
      json: { mfaToken: 'x', platform: 'native', code: ['123456'] },
    });
    expect(mfa.status).toBe(400);
    expect(await mfa.json()).toMatchObject({ error: 'invalid_request' });
  });
});
