import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ path: relative(SRC, join(SRC, file)).split('\\').join('/'), text: readFileSync(join(SRC, file), 'utf8') }));
}

describe('isolation (source)', () => {
  it('only access/resolve.ts, the join and decline handlers and the staff handlers import stores/cross-tenant.ts', () => {
    // A type-only import grants no access to the operations, so it is not counted.
    const importers = sourceFiles()
      .filter((file) => /^import (?!type )[^;]*from '[./]+(stores\/)?cross-tenant\.ts';/m.test(file.text))
      .map((file) => file.path)
      .sort();
    // handlers/me.ts holds the join and decline handlers; handlers/admin.ts and handlers/deletion.ts hold the staff handlers.
    expect(importers).toEqual(['access/resolve.ts', 'handlers/admin.ts', 'handlers/deletion.ts', 'handlers/me.ts']);
  });

  it('product code answers 401 only through userGone() in access/resolve.ts', () => {
    const with401 = sourceFiles().filter((file) => /\b401\b/.test(file.text)).map((file) => file.path);
    expect(with401).toEqual(['access/resolve.ts']);
    const resolve = sourceFiles().find((file) => file.path === 'access/resolve.ts')?.text ?? '';
    expect(resolve.match(/\b401\b/g)).toHaveLength(1);
    expect(resolve).toMatch(/export function userGone\(\): never \{\n\s+throw new AppError\(401, 'unauthenticated'/);
  });

  it('only access/policy.ts mints an OrgScope', () => {
    const casts = sourceFiles().filter((file) => /as OrgScope\b/.test(file.text)).map((file) => file.path);
    expect(casts).toEqual(['access/policy.ts']);
  });

  it('only files/blobs.ts imports the Azure storage SDK', () => {
    const importers = sourceFiles().filter((file) => file.text.includes('from \'@azure/storage-blob\'')).map((file) => file.path);
    expect(importers).toEqual(['files/blobs.ts']);
  });
});
