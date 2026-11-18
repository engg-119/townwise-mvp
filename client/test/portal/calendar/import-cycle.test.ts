import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Home's week (analytics/week.ts) builds its cells from the Calendar's model (D49), so the model must not import the
// week back at run time: a cycle between them works only while neither uses the other at the top level. Type-only
// imports are erased and do not count. The shared week dates live in analytics/cells.ts.

const root = join(__dirname, '../../../src/portal');

/** The modules a file imports at run time (not `import type`). */
function runtimeImports(file: string): string[] {
  const source = readFileSync(join(root, file), 'utf8');
  return [...source.matchAll(/^import (?!type\b)[^;]*? from '([^']+)';/gms)].map((match) => match[1] ?? '');
}

test('the Calendar model and Home’s week do not import each other at run time', () => {
  expect(runtimeImports('analytics/week.ts')).toContain('../calendar/model');
  expect(runtimeImports('calendar/model.ts')).not.toContain('../analytics/week');
});
