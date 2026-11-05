import { expect, test } from 'vitest';

import { AUTH_ROUTES } from '../src/routes.ts';
import { call, WEB_ORIGIN } from './helpers/http.ts';
import { CLIENT_IDS, createGoogleFake } from './helpers/google-fake.ts';
import { startAuthServer } from './helpers/server.ts';

test('the router serves exactly the frozen route table', async () => {
  const fake = await createGoogleFake();
  const server = await startAuthServer({
    env: { AUTH_GOOGLE_CLIENT_IDS: CLIENT_IDS.join(',') },
    deps: { googleKeys: fake.keys },
  });
  try {
    for (const route of AUTH_ROUTES) {
      const res = await call(server.url, `/auth${route.path}`, {
        method: route.method,
        origin: WEB_ORIGIN,
        ...(route.method === 'POST' ? { json: {} } : {}),
      });
      expect(res.status, `${route.method} ${route.path}`).not.toBe(404);
    }
    const absent = [
      ['GET', '/auth/magic-link/redeem'],
      ['GET', '/auth/refresh'],
      ['POST', '/auth/sessions'],
    ] as const;
    for (const [method, path] of absent) {
      const res = await call(server.url, path, {
        method,
        ...(method === 'POST' ? { json: {} } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  } finally {
    await server.close();
  }
});
