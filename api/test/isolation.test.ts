import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ path: relative(SRC, join(SRC, file)).split('\\').join('/'), text: readFileSync(join(SRC, file), 'utf8') }));
}

describe('isolation (source)', () => {
  it('only access/resolve.ts, the join and decline handlers, the staff handlers, the file reader and the sweeper import stores/cross-tenant.ts', () => {
    // A type-only import grants no access to the operations, so it is not counted.
    const importers = sourceFiles()
      .filter((file) => /^import (?!type )[^;]*from '[./]+(stores\/)?cross-tenant\.ts';/m.test(file.text))
      .map((file) => file.path)
      .sort();
    // handlers/me.ts holds the join and decline handlers; handlers/admin.ts and handlers/deletion.ts hold the staff handlers.
    expect(importers).toEqual(['access/resolve.ts', 'files/sweeper.ts', 'files/worker.ts', 'handlers/admin.ts', 'handlers/deletion.ts', 'handlers/me.ts']);
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

  it('only the file code reaches stored files, and chat/* never does', () => {
    // Every value import (type-only grants nothing), resolved to a path under src/.
    const imports = (file: { path: string; text: string }): string[] => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
      .map((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')));
    const importersOf = (target: string): string[] => sourceFiles().filter((file) => imports(file).includes(target)).map((file) => file.path).sort();
    const fileCode = (path: string): boolean => path.startsWith('files/')
      || ['handlers/files.ts', 'handlers/sales.ts', 'handlers/locations.ts', 'handlers/deletion.ts', 'stores/index.ts', 'stores/file-entries.ts', 'stores/cross-tenant.ts', 'main.ts'].includes(path);
    for (const target of ['stores/files.ts', 'stores/file-entries.ts', 'files/blobs.ts', 'files/worker.ts']) {
      expect(importersOf(target).filter((path) => !fileCode(path))).toEqual([]);
    }
    expect(importersOf('stores/files.ts')).toEqual(['stores/cross-tenant.ts', 'stores/file-entries.ts', 'stores/index.ts']);
    expect(importersOf('stores/file-entries.ts')).toEqual(['stores/index.ts']);
    expect(sourceFiles().filter((file) => file.path.startsWith('chat/') && imports(file).some((path) => path.startsWith('files/') || path === 'stores/files.ts')))
      .toEqual([]);
  });

  it('only chat/model.ts and files/extract/model.ts construct a model client', () => {
    const constructs = sourceFiles().filter((file) => /^import Anthropic(?:,| )[^;]*from '@anthropic-ai\/sdk';/m.test(file.text)).map((file) => file.path).sort();
    expect(constructs).toEqual(['chat/model.ts', 'files/extract/model.ts']);
  });

  it('only files/parse/pdf.ts imports the PDF parser, and only files/parse/docx.ts the XML parser', () => {
    expect(sourceFiles().filter((file) => file.text.includes('from \'unpdf\'')).map((file) => file.path)).toEqual(['files/parse/pdf.ts']);
    expect(sourceFiles().filter((file) => file.text.includes('from \'saxen\'')).map((file) => file.path)).toEqual(['files/parse/docx.ts']);
  });

  it('only access/policy.ts mints the reader’s scope, and only files/worker.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForClaimedImport(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/worker.ts']);
  });

  it('only access/policy.ts mints the sweep’s scope, and only files/sweeper.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForSweep(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/sweeper.ts']);
  });
});
