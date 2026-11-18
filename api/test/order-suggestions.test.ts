// The ordering suggestions' schema and check (spec D41, D56) live in orders/suggestions.ts and their helpers in
// model-answer.ts, so chat code can use them without importing file code, even through one hop (isolation.test.ts
// checks direct imports only). The file code re-exports both, so there is one of each.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as readerPrompt from '../src/files/extract/reader-prompt.ts';
import * as setupPrompt from '../src/files/extract/setup-prompt.ts';
import * as modelAnswer from '../src/model-answer.ts';
import * as suggestions from '../src/orders/suggestions.ts';

const SRC = join(import.meta.dirname, '..', 'src');

/** Every import or re-export of a relative path in `file`, type-only ones too. */
function relativeImports(file: string): string[] {
  return [...readFileSync(join(SRC, file), 'utf8').matchAll(/^(?:import|export)\b[^;]*\bfrom '(\.[^']+)';/gm)].map((match) => match[1] ?? '');
}

describe('orders/suggestions.ts', () => {
  it('the setup read’s schema and check are the ones orders/suggestions.ts exports', () => {
    expect(setupPrompt.setupAnswer).toBe(suggestions.setupAnswer);
    expect(setupPrompt.setupResult).toBe(suggestions.setupResult);
    expect(setupPrompt.nameKey).toBe(suggestions.nameKey);
    expect(setupPrompt.SETUP_CONTENT_KINDS).toBe(suggestions.SETUP_CONTENT_KINDS);
    expect([
      setupPrompt.SETUP_SUPPLIERS_MAX, setupPrompt.SETUP_DELIVERIES_MAX, setupPrompt.SETUP_ITEMS_MAX, setupPrompt.SETUP_POS_NAMES_MAX,
      setupPrompt.SUPPLIER_NAME_CHARS, setupPrompt.ITEM_NAME_CHARS, setupPrompt.POS_NAME_CHARS, setupPrompt.ITEM_NOTE_CHARS,
    ]).toEqual([
      suggestions.SETUP_SUPPLIERS_MAX, suggestions.SETUP_DELIVERIES_MAX, suggestions.SETUP_ITEMS_MAX, suggestions.SETUP_POS_NAMES_MAX,
      suggestions.SUPPLIER_NAME_CHARS, suggestions.ITEM_NAME_CHARS, suggestions.POS_NAME_CHARS, suggestions.ITEM_NOTE_CHARS,
    ]);
    expect([suggestions.SETUP_SUPPLIERS_MAX, suggestions.SETUP_DELIVERIES_MAX, suggestions.SETUP_ITEMS_MAX, suggestions.SETUP_POS_NAMES_MAX]).toEqual([20, 7, 150, 10]);
  });

  it('reader-prompt.ts and setup-prompt.ts re-export the helpers of model-answer.ts, and orders/suggestions.ts imports nothing under files/', () => {
    expect(readerPrompt.entries).toBe(modelAnswer.entries);
    expect(readerPrompt.isRecord).toBe(modelAnswer.isRecord);
    expect(readerPrompt.oneOf).toBe(modelAnswer.oneOf);
    expect(readerPrompt.redacted).toBe(modelAnswer.redacted);
    expect(modelAnswer.redacted('call (603) 555-0123 or a@b.example', 80)).toBe('call [phone] or [email]');

    // Type-only imports count here too: the module is meant to stand apart from the file code altogether.
    expect(relativeImports('orders/suggestions.ts').sort()).toEqual(['../model-answer.ts', './setup.ts']);
    expect(relativeImports('model-answer.ts')).toEqual([]);
    // And the file code holds no second copy of either.
    const setupPromptText = readFileSync(join(SRC, 'files/extract/setup-prompt.ts'), 'utf8');
    expect(setupPromptText).not.toMatch(/export function setupResult|export const setupAnswer\b|export function nameKey/);
    expect(readFileSync(join(SRC, 'files/extract/reader-prompt.ts'), 'utf8')).not.toMatch(/export function (?:entries|isRecord|oneOf|redacted)\b/);
  });
});

// Security review M1: the email pattern is quadratic on a long run with no "@", and a stored chat call is checked
// again on every read of its conversation, so no model-written string may reach a pattern unbounded.
describe('a model-written string of any length', () => {
  const RUN = 'a'.repeat(60_000);
  const item = { name: 'Sample Lager', supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null, posNames: [], note: '' };
  const timed = <T>(work: () => T): { result: T; ms: number } => {
    const start = performance.now();
    const result = work();
    return { result, ms: performance.now() - start };
  };

  it('is checked in well under 100 ms: a note, a name, a supplier, a point-of-sale name and a redacted text of 60,000 characters', () => {
    const answer = {
      kind: 'order_guide', confidence: 'high', itemsCut: false,
      suppliers: [{ name: RUN, deliveries: [{ deliveryWeekday: 2, cutoffWeekday: null, cutoffTime: RUN }] }],
      items: [
        { ...item, note: RUN },
        { ...item, name: 'Sample Stout', note: `${RUN} ${RUN}`, supplier: RUN, posNames: [{ name: RUN, perSale: 1 }] },
        { ...item, name: RUN },
      ],
    };
    const checked = timed(() => suggestions.setupResult(answer, null));
    expect(checked.ms).toBeLessThan(100);
    // A name past its limit is no name, as before; a note keeps its first 120 characters.
    expect(checked.result?.suppliers).toEqual([]);
    expect(checked.result?.items.map((each) => [each.name, each.note.length, each.supplier, each.posNames])).toEqual([
      ['Sample Lager', 120, null, []], ['Sample Stout', 120, null, []],
    ]);
    expect(timed(() => modelAnswer.redacted(RUN, 600)).ms).toBeLessThan(100);
    expect(modelAnswer.redacted(RUN, 600)).toBe(RUN.slice(0, 600));
  });

  it('within the scan bound, four times the limit, is redacted exactly as before; past it only the start is read', () => {
    const tail = ' Ask rep@quillvane.example or (603) 555-0123.';
    // An address 400 characters in is still found and replaced before the cut at 120.
    const padded = `${'x '.repeat(40)}rep@quillvane.example ${'y '.repeat(150)}${tail}`;
    expect(padded.length).toBeLessThanOrEqual(120 * 4);
    expect(modelAnswer.redacted(padded, 120)).toBe(`${'x '.repeat(40)}[email] ${'y '.repeat(150)}`.slice(0, 120));
    expect(modelAnswer.redacted(`Call (603) 555-0123 or a.b+c@d-e.example.org now`, 120)).toBe('Call [phone] or [email] now');
    // Addresses back to back are each replaced.
    expect(modelAnswer.redacted('a@b.co.uk1x@y.org', 120)).toBe('[email][email]');
    // Past the bound nothing is read: what is kept is the same first characters.
    expect(modelAnswer.redacted(`${'z'.repeat(480)}${tail}`, 120)).toBe('z'.repeat(120));
    expect(modelAnswer.REDACT_SCAN_FACTOR).toBe(4);
  });
});

