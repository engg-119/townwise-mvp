import { describe, expect, it } from 'vitest';

import { expectationOf, replayFixture, scoreCurated, type ResearchFixture } from '../scripts/research-eval-full.ts';
import type { Finding } from '../src/research/verify.ts';
import { evalRefusal, parseEvalArgs, runResearchEval, type EvalDeps } from '../scripts/research-eval.ts';
import { cited, citedQuotes, message, messagesOf, scriptedModel, text, webResults, webSearch } from './helpers/chat-model.ts';

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

  it('refuses bad arguments before any request', async () => {
    const { deps, calls } = counted();
    await expect(runResearchEval(['--groups', 'town-off,nope'], ready, deps)).resolves.toBe(2);
    await expect(runResearchEval(['--max-usd', '0'], ready, deps)).resolves.toBe(2);
    expect(calls).toEqual({ model: 0, fetch: 0 });
  });
});

describe('research-eval parseEvalArgs', () => {
  it('defaults to every group, a $25 cap and a 30-row sample', () => {
    expect(parseEvalArgs([])).toEqual({
      probes: true, groups: ['town-off', 'town-on', 'location'], restaurant: null, maxUsd: 25, concurrency: 3, sample: 30,
      record: false, redact: [], out: null, saveRuns: null, fromRuns: null,
    });
  });

  it('reads every flag', () => {
    expect(parseEvalArgs([
      '--no-probes', '--groups', 'location', '--restaurant', 'Some Diner', '--redact', 'some', '--redact', 'diner',
      '--max-usd', '5', '--concurrency', '1', '--sample', '10', '--record', '--out', '/tmp/x.json', '--save-runs', '/tmp/r.json',
      '--from-runs', '/tmp/f.json',
    ])).toEqual({
      probes: false, groups: ['location'], restaurant: 'Some Diner', maxUsd: 5, concurrency: 1, sample: 10, record: true,
      redact: ['some', 'diner'], out: '/tmp/x.json', saveRuns: '/tmp/r.json', fromRuns: '/tmp/f.json',
    });
  });
});

describe('research-eval full run (scripted model)', () => {
  const NOW = new Date('2026-11-19T15:00:00Z');
  const PAGE = (n: number): string => `https://sentinel-page${String(n)}.example/calendar`;

  /** One town thread: a gather citing a page that states the date, then an extract naming one event. */
  function townThread(model: ReturnType<typeof scriptedModel>, n: number, start: string, title: string): void {
    const quote = `Sentinel-${title} on ${start === '2026-11-21' ? 'November 21, 2026' : 'February 4, 2027'}`;
    model.script(
      { kind: 'message', message: message([webSearch(`srv_${String(n)}`), webResults(`srv_${String(n)}`, [PAGE(n)]), citedQuotes(`EVENT: ${title}`, [{ url: PAGE(n), quote }])], { usage: { searches: 1 } }) },
      { kind: 'message', message: message([text(JSON.stringify({
        events: [{
          title, kind: 'event', category: 'sports', startDate: start, endDate: start, weekdays: null, startTime: null, status: 'scheduled',
          venueRef: null, hostRef: null, competitor: null, sourceIds: ['S1'], dateQuote: quote, confidence: 'high',
        }],
        entities: [],
      }))]) },
    );
  }

  it('scores recall against the curated rows, writes the results and records fixtures, printing no title or URL', async () => {
    const model = scriptedModel();
    // Two threads find the curated Brown game (one is a cross-thread duplicate), one finds Winter Carnival, three find nothing.
    townThread(model, 1, '2026-11-21', 'Home football vs Brown');
    townThread(model, 2, '2026-11-21', 'Football vs Brown at home');
    townThread(model, 3, '2027-02-04', 'Winter Carnival');
    for (let n = 4; n <= 6; n += 1) model.script({ kind: 'message', message: message([text('Sentinel: nothing found')]) });
    const written = new Map<string, unknown>();
    const lines: string[] = [];
    const deps: EvalDeps = {
      model: () => model,
      fetch: () => Promise.reject(new Error('no Places call without --probe')),
      log: (line) => { lines.push(line); },
      writeJson: (path, value) => { written.set(path, value); return Promise.resolve(); },
      now: () => NOW,
    };
    const env = { TOWNWISE_RESEARCH_EVAL: '1', ANTHROPIC_API_KEY: 'sk-secret-anthropic' };

    await expect(runResearchEval(['--no-probes', '--groups', 'town-off', '--concurrency', '1', '--record', '--out', '/x/results.json', '--save-runs', '/x/runs.json'], env, deps)).resolves.toBe(0);

    expect(model.remaining()).toBe(0);
    const out = lines.join('\n');
    expect(out).toMatch(/recall, curated event rows: 0\.667 \(2\/3\)/);
    expect(out).toMatch(/1 cross-thread duplicates, 2 curated/);
    expect(out).toMatch(/3 empty or failed/);
    for (const secret of ['sk-secret-anthropic', 'Sentinel', 'sentinel-page', 'Brown', 'Carnival']) expect(out).not.toContain(secret);

    const result = written.get('/x/results.json') as { runs: { group: string; inserts: unknown[] }[]; spentMicroUsd: number };
    expect(result.runs.map((run) => run.group)).toEqual(['town-off']);
    expect(result.runs[0]?.inserts).toEqual([]);
    const fixtures = [...written.keys()].filter((path) => path.includes('fixtures/research/'));
    expect(fixtures.map((path) => path.split('/').at(-1))).toEqual(['hanover-schools.json', 'hanover-sports.json', 'hanover-arts_festivals.json']);
    const fixture = written.get(fixtures[0] ?? '') as ResearchFixture;
    expect(JSON.stringify(fixture)).not.toMatch(/encrypted_(content|index)/);
    expect(fixture.expected.kind).toBe('recorded');
    // The fixture replays to its own expectation.
    expect(expectationOf(await replayFixture(fixture))).toEqual(fixture.expected);

    // The saved runs score again with no model call.
    const again: string[] = [];
    const reread = JSON.parse(JSON.stringify(written.get('/x/runs.json'))) as unknown;
    await expect(runResearchEval(['--groups', 'town-off', '--from-runs', '/x/runs.json'], env, {
      ...deps, model: () => scriptedModel(), log: (line) => { again.push(line); }, readJson: () => Promise.resolve(reread),
    })).resolves.toBe(0);
    expect(again.join('\n')).toMatch(/recall, curated event rows: 0\.667 \(2\/3\)/);
    // Rescoring saved runs neither plans threads nor says it skipped any.
    expect(again.join('\n')).not.toMatch(/reservations|skipped, no --restaurant/);
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

describe('research-eval scoreCurated', () => {
  const term = { id: 't', title: 'Fall term finals', start: '2026-11-20', end: '2026-11-25', kind: 'term', scope: 'town', group: null, groupLabel: null, confidence: 'high', sources: [] } as const;
  const finding = (category: 'school' | 'sports', start: string): Finding => ({
    title: 'Something else entirely', kind: 'event', category, start, end: start, weekdays: null, startTime: null, status: 'scheduled',
    venueRef: null, hostRef: null, competitor: null, sources: [], grounded: true, codeConfidence: 'medium', confidence: 'medium',
  });

  it('finds a term row only by a school finding on its first or last day', () => {
    expect(scoreCurated([term], [{ thread: 'sports', events: [finding('sports', '2026-11-25')], entities: [] }])[0]?.foundBy).toEqual([]);
    expect(scoreCurated([term], [{ thread: 'schools', events: [finding('school', '2026-11-25')], entities: [] }])[0]?.foundBy).toEqual(['schools']);
  });
});
