import { act, render } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';
import type { z } from 'zod';

import { ApiError, type RequestOptions } from '../../../src/api/client';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { fakePortalApi, STAFF_EMAIL, staffMe, type FakePortalApi } from '../../helpers/portal';

// The staff console is web only (the native frame shows one line instead), so its pages render on web: the whole
// app through ExpoRoot, signed in as staff, at 1280px unless a test narrows it. `consoleApi` answers the admin
// routes by "METHOD /path" before the shared portal fake, and records every call in `calls`.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

/** The viewport width react-native-web reports (jsdom's is 0, a phone). */
export function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

export type Answer = (body: unknown) => unknown;

export interface ConsoleApi extends FakePortalApi {
  /** Answers by "METHOD /path": a body, an ApiError to throw, or a promise of either. */
  routes: Record<string, Answer>;
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  return schema.parse(resolved);
}

export function consoleApi(me: MeResponse = staffMe()): ConsoleApi {
  const base = fakePortalApi({ me });
  const shared = { json: base.json.bind(base), request: base.request.bind(base) };
  const routes: Record<string, Answer> = {};
  return Object.assign(base, {
    routes,
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      const answer = routes[`${method} ${path}`];
      if (answer === undefined) return shared.json(path, schema, opts);
      base.calls.push({ method, path, body: opts?.body });
      return settle(answer(opts?.body), schema);
    },
    async request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      const method = opts?.method ?? 'GET';
      const answer = routes[`${method} ${path}`];
      if (answer === undefined) return shared.request(path, opts);
      base.calls.push({ method, path, body: opts?.body });
      const resolved: unknown = await answer(opts?.body);
      if (resolved instanceof ApiError) throw resolved;
      return { ok: true, status: 204 } as unknown as Response;
    },
  });
}

export function renderAt(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 's1', email: STAFF_EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

export * from './fixtures';
