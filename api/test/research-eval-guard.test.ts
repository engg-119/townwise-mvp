import { describe, expect, it } from 'vitest';

import { evalRefusal, runResearchEval, type EvalDeps } from '../scripts/research-eval.ts';
import { cited, message, messagesOf, scriptedModel, text, webResults, webSearch } from './helpers/chat-model.ts';

/** Deps that count every model build and Google call, and keep the printed lines. */
function counted(): { deps: EvalDeps; calls: { model: number; fetch: number }; lines: string[] } {
  const calls = { model: 0, fetch: 0 };
  const lines: string[] = [];
  const deps: EvalDeps = {
    model: () => { calls.model += 1; throw new Error('no model call while the guard refuses'); },
    fetch: () => { calls.fetch += 1; return Promise.reject(new Error('no Places call while the guard refuses')); },
    log: (line) => { lines.push(line); },
  };
  return { deps, calls, lines };
}

describe('research-eval guard (D66 task 0.2: opt-in, never in CI, never in production)', () => {
  const ready = { TOWNWISE_RESEARCH_EVAL: '1', ANTHROPIC_API_KEY: 'k', GOOGLE_PLACES_API_KEY: 'g' };

  it.each([
    ['no environment', {}],
    ['no opt-in', { ANTHROPIC_API_KEY: 'k', GOOGLE_PLACES_API_KEY: 'g' }],
    ['an opt-in other than 1', { ...ready, TOWNWISE_RESEARCH_EVAL: 'true' }],
    ['production', { ...ready, NODE_ENV: 'production' }],
    ['no key', { ...ready, ANTHROPIC_API_KEY: '' }],
  ])('exits 0 with no model or Places call: %s', async (_name, env) => {
    const { deps, calls, lines } = counted();
    await expect(runResearchEval(['--probe'], env, deps)).resolves.toBe(0);
    expect(calls).toEqual({ model: 0, fetch: 0 });
    expect(lines).toEqual([expect.stringMatching(/^research-eval: not run \(/)]);
  });

  it('refuses production even with the opt-in and a key', () => {
    expect(evalRefusal({ ...ready, NODE_ENV: 'production' })).toMatch(/production/);
    expect(evalRefusal(ready)).toBeNull();
  });

  it('never prints the key', async () => {
    const { deps, lines } = counted();
    await runResearchEval(['--probe'], { ...ready, ANTHROPIC_API_KEY: 'sk-secret', NODE_ENV: 'production' }, deps);
    expect(lines.join('\n')).not.toContain('sk-secret');
  });

  it('makes no request without --probe while the full eval is unbuilt', async () => {
    const { deps, calls } = counted();
    await expect(runResearchEval([], ready, deps)).resolves.toBe(2);
    expect(calls).toEqual({ model: 0, fetch: 0 });
  });
});

describe('research-eval --probe output (counts and shapes only)', () => {
  const PAGE = 'https://sentinel-page.example/events#today';

  /** Every string a page, a search, the extract or Google can return carries "Sentinel"; none may be printed. */
  function scripted(): ReturnType<typeof scriptedModel> {
    const model = scriptedModel();
    const extracted = JSON.stringify({
      events: [{
        title: 'Sentinel-event title', kind: 'event', startDate: '2026-12-01', endDate: '2026-12-01', startTime: null,
        status: 'scheduled', sourceIds: ['S1'], dateQuote: 'Sentinel-date quote', confidence: 'high',
      }],
    });
    model.script(
      // Probe 1 pauses once, then finishes: the continuation resends the paused content.
      { kind: 'message', message: message([webSearch('srv_1'), webResults('srv_1', [PAGE])], { stopReason: 'pause_turn', usage: { searches: 1 } }) },
      { kind: 'message', message: message([cited('Sentinel-gathered paragraph', [PAGE])]) },
      { kind: 'message', message: message([text(extracted)]) },
      { kind: 'message', message: message([webSearch('srv_2'), webResults('srv_2', [PAGE]), text(extracted)], { usage: { searches: 1 } }) },
    );
    return model;
  }

  it('prints no key, page text, URL, title, query or place name, and resends a paused message', async () => {
    const model = scripted();
    const fetched: RequestInit[] = [];
    const lines: string[] = [];
    const deps: EvalDeps = {
      model: () => model,
      fetch: (url, init) => {
        fetched.push(init);
        const body = url.endsWith(':searchNearby')
          ? { places: [{ id: 'place-1', displayName: { text: 'Sentinel-place name' }, primaryType: 'cafe', location: { latitude: 1, longitude: 2 } }] }
          : { id: 'place-1', displayName: { text: 'Sentinel-place name' }, formattedAddress: 'Sentinel-address' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      },
      log: (line) => { lines.push(line); },
    };
    const env = { TOWNWISE_RESEARCH_EVAL: '1', ANTHROPIC_API_KEY: 'sk-secret-anthropic', GOOGLE_PLACES_API_KEY: 'g-secret-places' };

    await expect(runResearchEval(['--probe'], env, deps)).resolves.toBe(0);

    expect(model.remaining()).toBe(0);
    expect(fetched).toHaveLength(3);
    const continuation = messagesOf(model.calls[1]);
    expect(continuation.map((m) => m.role)).toEqual(['user', 'assistant']);
    const out = lines.join('\n');
    expect(out).toMatch(/probe 3, pause_turn: message 0 paused/);
    expect(out).toMatch(/probe 4, profile: HTTP 200, fields displayName, formattedAddress, id/);
    for (const secret of ['sk-secret-anthropic', 'g-secret-places', 'Sentinel', 'sentinel-page.example', 'place-1']) {
      expect(out).not.toContain(secret);
    }
  });
});
