import { describe, expect, it } from 'vitest';

import { evalRefusal, runResearchEval, type EvalDeps } from '../scripts/research-eval.ts';

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
