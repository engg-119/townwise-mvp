import { expect, test } from 'vitest';

import type { SignInResult } from '../src/index.ts';
import { call } from './helpers/http.ts';
import { CLIENT_IDS, createGoogleFake, startFailingJwks, type GoogleFake } from './helpers/google-fake.ts';
import { signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const FOREIGN_AUD = '2222-other.apps.googleusercontent.com';

async function withGoogle(
  run: (server: AuthTestServer, fake: GoogleFake) => Promise<void>,
  opts?: { onUserCreated?: () => Promise<void> },
): Promise<void> {
  const fake = await createGoogleFake();
  const server = await startAuthServer({
    env: { AUTH_GOOGLE_CLIENT_IDS: CLIENT_IDS.join(',') },
    deps: {
      googleKeys: fake.keys,
      ...(opts?.onUserCreated !== undefined ? { onUserCreated: opts.onUserCreated } : {}),
    },
  });
  try {
    await run(server, fake);
  } finally {
    await server.close();
  }
}

function seconds(server: AuthTestServer): number {
  return Math.floor(server.clock.now().getTime() / 1000);
}

function idToken(server: AuthTestServer, fake: GoogleFake, claims: Record<string, unknown>): Promise<string> {
  const now = seconds(server);
  return fake.signIdToken({ iat: now, exp: now + 3600, ...claims });
}

function postGoogle(server: AuthTestServer, token: string): Promise<Response> {
  return call(server.url, '/auth/google', { json: { idToken: token, platform: 'native' } });
}

async function bodyOf(res: Response): Promise<SignInResult> {
  return await res.json() as SignInResult;
}

test('first-time Google sign-in rejects an ID token issued to another client id', async () => {
  await withGoogle(async (server, fake) => {
    const token = await idToken(server, fake, {
      sub: 'sub-foreign',
      email: 'ada@gmail.com',
      aud: FOREIGN_AUD,
    });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_google_token' });
    expect(await server.connection.collection('users').countDocuments()).toBe(0);
  });
});

test('returning sign-in rejects a foreign audience too', async () => {
  await withGoogle(async (server, fake) => {
    const user = await server.stores.users.create({
      email: 'ada@gmail.com',
      googleSubject: 'sub-ada',
      now: server.clock.now(),
    });
    const token = await idToken(server, fake, { sub: 'sub-ada', email: 'ada@gmail.com', aud: FOREIGN_AUD });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_google_token' });
    const after = await server.stores.users.findById(user.id);
    expect(after?.email).toBe('ada@gmail.com');
    expect(after?.googleSubject).toBe('sub-ada');
  });
});

test('rejects a wrong issuer, an expired token and email_verified false', async () => {
  await withGoogle(async (server, fake) => {
    const now = seconds(server);
    const wrongIssuer = await idToken(server, fake, {
      sub: 'sub-iss',
      email: 'ada@gmail.com',
      iss: 'https://evil.example.test',
    });
    const expired = await fake.signIdToken({
      sub: 'sub-exp',
      email: 'ada@gmail.com',
      iat: now - 3600,
      exp: now - 30,
    });
    const unverified = await idToken(server, fake, {
      sub: 'sub-unverified',
      email: 'ada@gmail.com',
      email_verified: false,
    });
    const issuerRes = await postGoogle(server, wrongIssuer);
    const expiredRes = await postGoogle(server, expired);
    const unverifiedRes = await postGoogle(server, unverified);
    expect(issuerRes.status).toBe(401);
    expect(await issuerRes.json()).toMatchObject({ error: 'invalid_google_token' });
    expect(expiredRes.status).toBe(401);
    expect(await expiredRes.json()).toMatchObject({ error: 'invalid_google_token' });
    expect(unverifiedRes.status).toBe(403);
    expect(await unverifiedRes.json()).toMatchObject({ error: 'google_email_unverified' });
    expect(await server.connection.collection('users').countDocuments()).toBe(0);
  });
});

test('accepts an ID token issued to any listed client id', async () => {
  await withGoogle(async (server, fake) => {
    for (const aud of CLIENT_IDS) {
      const name = aud.split('-')[1] ?? 'client';
      const token = await idToken(server, fake, { sub: `sub-${name}`, email: `${name}@gmail.com`, aud });
      const res = await postGoogle(server, token);
      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body.status).toBe('signed_in');
    }
    expect(await server.connection.collection('users').countDocuments()).toBe(CLIENT_IDS.length);
  });
});

test('finds the account by sub after the Google email changes', async () => {
  await withGoogle(async (server, fake) => {
    const user = await server.stores.users.create({
      email: 'ada@gmail.com',
      googleSubject: 'sub-ada',
      now: server.clock.now(),
    });
    const token = await idToken(server, fake, { sub: 'sub-ada', email: 'bea@gmail.com' });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    if (body.status !== 'signed_in') throw new Error('expected a sign-in');
    expect(body.user.id).toBe(user.id);
    expect(body.isNewUser).toBe(false);
    expect(await server.connection.collection('users').countDocuments()).toBe(1);
    expect(await server.stores.users.findByGoogleSubject('sub-ada')).toMatchObject({ id: user.id });
  });
});

test('sub sign-in with a changed authoritative email updates the stored email', async () => {
  await withGoogle(async (server, fake) => {
    const user = await server.stores.users.create({
      email: 'ada@gmail.com',
      googleSubject: 'sub-ada',
      now: server.clock.now(),
    });
    const token = await idToken(server, fake, { sub: 'sub-ada', email: 'bea@gmail.com' });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(200);
    expect(await server.stores.users.findById(user.id)).toMatchObject({ email: 'bea@gmail.com' });
  });
});

test('a changed email held by another account is 409 google_email_conflict', async () => {
  await withGoogle(async (server, fake) => {
    const ada = await server.stores.users.create({
      email: 'ada@gmail.com',
      googleSubject: 'sub-ada',
      now: server.clock.now(),
    });
    await server.stores.users.create({ email: 'bea@gmail.com', now: server.clock.now() });
    const token = await idToken(server, fake, { sub: 'sub-ada', email: 'bea@gmail.com' });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'google_email_conflict' });
    expect(await server.stores.users.findById(ada.id)).toMatchObject({ email: 'ada@gmail.com' });
  });
});

test('409 when the email\'s account is linked to another Google sub', async () => {
  await withGoogle(async (server, fake) => {
    const owner = await server.stores.users.create({
      email: 'ada@gmail.com',
      googleSubject: 'sub-owner',
      now: server.clock.now(),
    });
    const token = await idToken(server, fake, { sub: 'sub-other', email: 'ada@gmail.com' });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'email_linked_to_other_google_account' });
    expect(await server.stores.users.findById(owner.id)).toMatchObject({ googleSubject: 'sub-owner' });
  });
});

test('concurrent first sign-ins for one Google account create exactly one user and call onUserCreated once', async () => {
  let created = 0;
  await withGoogle(async (server, fake) => {
    const token = await idToken(server, fake, { sub: 'sub-race', email: 'ada@gmail.com' });
    const [first, second] = await Promise.all([postGoogle(server, token), postGoogle(server, token)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const bodies = [await bodyOf(first), await bodyOf(second)];
    expect(bodies.filter((body) => body.status === 'signed_in' && body.isNewUser)).toHaveLength(1);
    expect(await server.connection.collection('users').countDocuments()).toBe(1);
    expect(created).toBe(1);
  }, {
    onUserCreated: () => {
      created += 1;
      return Promise.resolve();
    },
  });
});

test('isNewUser is true only for the creating request', async () => {
  await withGoogle(async (server, fake) => {
    const token = await idToken(server, fake, { sub: 'sub-once', email: 'ada@gmail.com' });
    const first = await postGoogle(server, token);
    const second = await postGoogle(server, token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await bodyOf(first);
    const secondBody = await bodyOf(second);
    if (firstBody.status !== 'signed_in' || secondBody.status !== 'signed_in') throw new Error('expected sign-in');
    expect(firstBody.isNewUser).toBe(true);
    expect(secondBody.isNewUser).toBe(false);
    expect(firstBody.user.id).toBe(secondBody.user.id);
  });
});

test('503 when the key endpoint answers 500, times out or refuses the connection', async () => {
  const fake = await createGoogleFake();
  const now = Math.floor(Date.parse('2026-06-01T12:00:00.000Z') / 1000);
  const token = await fake.signIdToken({
    sub: 'sub-503',
    email: 'ada@gmail.com',
    iat: now,
    exp: now + 3600,
  });
  for (const mode of ['status500', 'hang', 'refused'] as const) {
    const jwks = await startFailingJwks(mode);
    const server = await startAuthServer({
      env: { AUTH_GOOGLE_CLIENT_IDS: CLIENT_IDS.join(',') },
      deps: { googleKeys: jwks.keys },
    });
    try {
      const res = await postGoogle(server, token);
      expect(res.status, mode).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'google_unavailable' });
    } finally {
      await server.close();
      await jwks.close();
    }
  }
});

test('POST /google is 404 when AUTH_GOOGLE_CLIENT_IDS is unset', async () => {
  const server = await startAuthServer();
  try {
    const res = await call(server.url, '/auth/google', {
      json: { idToken: 'not-a-token', platform: 'native' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  } finally {
    await server.close();
  }
});

test('links an existing magic-link account when the email is @gmail.com', async () => {
  await withGoogle(async (server, fake) => {
    const signed = await signIn(server, 'native', 'ada@gmail.com');
    if (signed.body.status !== 'signed_in') throw new Error('expected a sign-in');
    const before = await server.stores.users.findById(signed.body.user.id);
    expect(before?.googleSubject).toBeNull();
    const token = await idToken(server, fake, { sub: 'sub-gmail', email: 'ada@gmail.com' });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    if (body.status !== 'signed_in') throw new Error('expected a google sign-in');
    expect(body.isNewUser).toBe(false);
    expect(body.user.id).toBe(signed.body.user.id);
    expect(await server.stores.users.findById(signed.body.user.id)).toMatchObject({ googleSubject: 'sub-gmail' });
  });
});

test('refuses to create or link for a non-Gmail, non-Workspace email', async () => {
  await withGoogle(async (server, fake) => {
    const created = await idToken(server, fake, { sub: 'sub-new', email: 'ada@example.test' });
    const createRes = await postGoogle(server, created);
    expect(createRes.status).toBe(403);
    expect(await createRes.json()).toMatchObject({ error: 'google_email_not_authoritative' });
    expect(await server.stores.users.findByEmail('ada@example.test')).toBeNull();

    const signed = await signIn(server, 'native', 'bea@example.test');
    if (signed.body.status !== 'signed_in') throw new Error('expected a sign-in');
    const linked = await idToken(server, fake, { sub: 'sub-link', email: 'bea@example.test' });
    const linkRes = await postGoogle(server, linked);
    expect(linkRes.status).toBe(403);
    expect(await linkRes.json()).toMatchObject({ error: 'google_email_not_authoritative' });
    expect(await server.stores.users.findById(signed.body.user.id)).toMatchObject({ googleSubject: null });
  });
});

test('links a Workspace account when hd is present for a non-Gmail email', async () => {
  await withGoogle(async (server, fake) => {
    const signed = await signIn(server, 'native', 'ada@example.test');
    if (signed.body.status !== 'signed_in') throw new Error('expected a sign-in');
    const token = await idToken(server, fake, {
      sub: 'sub-workspace',
      email: 'ada@example.test',
      hd: 'example.test',
    });
    const res = await postGoogle(server, token);
    expect(res.status).toBe(200);
    expect(await server.stores.users.findById(signed.body.user.id)).toMatchObject({
      googleSubject: 'sub-workspace',
    });
  });
});
