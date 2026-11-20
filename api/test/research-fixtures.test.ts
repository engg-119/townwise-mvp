// D66 task 10.1: the live eval's recorded Hanover threads, replayed through the thread executor (research/call.ts
// runThread) with no network. Each fixture under test/fixtures/research/ holds every message the model answered in the
// live run (the gather's, then the extract's; encrypted fields and signatures stripped, the eval location's name
// redacted) and what the thread recorded from them, so a change to the ledger, the checks, grounding or confidence
// that changes what a real thread stores fails here.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expectationOf, replayFixture, type ResearchFixture } from '../scripts/research-eval-full.ts';
import { buildLedger } from '../src/research/ledger.ts';
import { TOWN_THREADS } from '../src/research/threads.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'research');
const fixtures = readdirSync(DIR).filter((name) => /^hanover-.*\.json$/.test(name)).sort()
  .map((name) => [name, JSON.parse(readFileSync(join(DIR, name), 'utf8')) as ResearchFixture] as const);

describe('recorded Hanover research threads (D66 live eval)', () => {
  it('holds a recording of every town thread and both location threads', () => {
    expect(fixtures.map(([, fixture]) => fixture.thread).sort()).toEqual([...TOWN_THREADS, 'competitors', 'neighborhood'].sort());
  });

  it.each(fixtures)('%s replays to its recorded findings, sources and drops', async (_name, fixture) => {
    const outcome = await replayFixture(fixture);
    expect(expectationOf(outcome)).toEqual(fixture.expected);
    expect(outcome.kind).toBe('recorded');
  });

  it.each(fixtures)('%s keeps no encrypted field, signature or page text beyond the cited quotes', (_name, fixture) => {
    const raw = JSON.stringify(fixture.responses);
    expect(raw).not.toMatch(/"encrypted_(content|index)"/);
    expect(raw).not.toMatch(/"signature":"[^"]/);
    expect(fixture.fetch).toBe(false);
  });

  it.each(fixtures)('%s stores only sources from the ledger, each https', async (_name, fixture) => {
    // The ledger of the gather's own messages, not any URL that appears somewhere in the recorded text.
    const outcome = await replayFixture(fixture);
    const ledgerUrls = new Set(buildLedger(outcome.messages).sources.map((source) => source.url));
    const cited = fixture.expected.verified?.events.flatMap((event) => event.sources.map((source) => source.url)) ?? [];
    expect(cited.length).toBeGreaterThan(0);
    for (const url of cited) {
      expect(url.startsWith('https://')).toBe(true);
      expect(ledgerUrls.has(url)).toBe(true);
    }
  });
});
