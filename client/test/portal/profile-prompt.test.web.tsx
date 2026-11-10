import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { resetProfiles } from '../../src/portal/profile/useProfile';
import { NamePrompt } from '../../src/portal/profile/NamePrompt';
import type { z } from 'zod';

import type { ApiClient, RequestOptions } from '../../src/api/client';
import { ACCESS, meOf, viewAsMe, type Call } from '../helpers/portal';
import { portalWrapper } from './files/harness';
import type { MeResponse } from '../../src/portal/schemas';

afterEach(() => {
  cleanup();
  resetProfiles();
});

interface Recorder { calls: Call[] }

function setup(me: MeResponse, profile: { displayName: string | null; askName: boolean }): Recorder {
  const recorder: Recorder = { calls: [] };
  let current = profile;
  const api: ApiClient = {
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      recorder.calls.push({ method, path, body: opts?.body });
      if (path !== '/api/me/profile') return Promise.reject(new Error('unexpected'));
      if (method === 'PATCH') current = { displayName: (opts?.body as { displayName: string | null }).displayName, askName: false };
      return Promise.resolve(schema.parse(current));
    },
    request: () => Promise.reject(new Error('unexpected')),
    stream: () => Promise.reject(new Error('unexpected')),
    logout: () => Promise.resolve(),
  };
  const Wrapper = portalWrapper(api, me);
  render(<Wrapper><NamePrompt /></Wrapper>);
  return recorder;
}

const sent = (r: Recorder): Call[] => r.calls.filter((call) => call.method !== 'GET');

test('asks once: Save name stores it and the prompt goes', async () => {
  const api = setup(meOf(ACCESS.member), { displayName: null, askName: true });
  expect(await screen.findByText('What should TownwiseAI call you?')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'First name' }), { target: { value: 'Cam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => { expect(screen.queryByText('What should TownwiseAI call you?')).toBeNull(); });
  expect(sent(api)).toEqual([{ method: 'PATCH', path: '/api/me/profile', body: { displayName: 'Cam' } }]);
});

test('Not now saves null and the prompt goes', async () => {
  const api = setup(meOf(ACCESS.member), { displayName: null, askName: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
  await waitFor(() => { expect(screen.queryByText('What should TownwiseAI call you?')).toBeNull(); });
  expect(sent(api)).toEqual([{ method: 'PATCH', path: '/api/me/profile', body: { displayName: null } }]);
});

test('a bad name stays in the field and nothing is sent', async () => {
  const api = setup(meOf(ACCESS.member), { displayName: null, askName: true });
  fireEvent.change(await screen.findByRole('textbox', { name: 'First name' }), { target: { value: 'Cam2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByText('Use letters, spaces, hyphens or apostrophes, up to 40 characters.')).toBeTruthy();
  expect(sent(api)).toEqual([]);
});

test('never shows under view-as or when the API does not ask', async () => {
  setup(viewAsMe(ACCESS.admin), { displayName: null, askName: true });
  await waitFor(() => { expect(screen.queryByText('What should TownwiseAI call you?')).toBeNull(); });
  cleanup();
  resetProfiles();
  const api = setup(meOf(ACCESS.member), { displayName: 'Cam', askName: false });
  await waitFor(() => { expect(api.calls.length).toBe(1); });
  expect(screen.queryByText('What should TownwiseAI call you?')).toBeNull();
});
