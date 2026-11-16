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
  it('only access/resolve.ts, the join and decline handlers, the staff handlers, the file reader, the TownwiseAI reader, the sweeper, the lab callback and the calendar refresh loop import stores/cross-tenant.ts', () => {
    // A type-only import grants no access to the operations, so it is not counted.
    const importers = sourceFiles()
      .filter((file) => /^import (?!type )[^;]*from '[./]+(stores\/)?cross-tenant\.ts';/m.test(file.text))
      .map((file) => file.path)
      .sort();
    // handlers/me.ts holds the join and decline handlers; handlers/admin.ts and handlers/deletion.ts hold the staff handlers.
    // lab/callback.ts holds the forecast lab job's callback, which finds its calibration by id and token before any
    // organization is known. files/ai-reader.ts (spec 11A.9) claims the next file someone asked TownwiseAI to read,
    // across organizations, as the file reader claims the next import. calendar/refresher.ts claims a due calendar link
    // in any organization.
    expect(importers).toEqual([
      'access/resolve.ts', 'calendar/refresher.ts', 'files/ai-reader.ts', 'files/sweeper.ts', 'files/worker.ts', 'handlers/admin.ts',
      'handlers/deletion.ts',
      'handlers/me.ts', 'lab/callback.ts',
    ]);
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
    for (const target of ['stores/files.ts', 'stores/file-entries.ts', 'files/blobs.ts', 'files/worker.ts', 'files/ai-reader.ts']) {
      expect(importersOf(target).filter((path) => !fileCode(path))).toEqual([]);
    }
    expect(importersOf('stores/files.ts')).toEqual(['stores/cross-tenant.ts', 'stores/file-entries.ts', 'stores/index.ts']);
    expect(importersOf('stores/file-entries.ts')).toEqual(['stores/index.ts']);
    expect(sourceFiles().filter((file) => file.path.startsWith('chat/') && imports(file).some((path) => path.startsWith('files/') || path === 'stores/files.ts')))
      .toEqual([]);
  });

  it('chat/* never touches ctx.files or stores.files, so item text comes only through ctx.items', () => {
    // Dotted reads, destructuring (flat or nested) and bracket reads of `files` from ctx or its stores.
    const reaches = /\bctx\.files\b|\.stores\.files\b|\bfileEntries\b|\{[^}]*\bfiles\b[^}]*\}\s*=\s*[\w.]*\b(?:ctx|stores)\b|\b(?:ctx|stores)\s*:\s*\{[^}]*\bfiles\b|\[\s*['"`]files['"`]\s*\]/;
    for (const sample of ['tc.ctx.files', 'ctx.stores.files.get(', 'const { files } = ctx.stores;', 'const { now, files } = tc.ctx;', 'const { stores: { files } } = ctx;', 'ctx.stores[\'files\']']) {
      expect(sample).toMatch(reaches);
    }
    const touching = sourceFiles()
      .filter((file) => file.path.startsWith('chat/') && reaches.test(file.text))
      .map((file) => file.path);
    expect(touching).toEqual([]);
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

  it('only access/policy.ts mints the TownwiseAI reader’s scope, and only files/ai-reader.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForClaimedAiRead(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/ai-reader.ts']);
  });

  it('a file’s own text leaves the parse code only for a file someone let TownwiseAI read (spec 11A.9) or attached (D36)', () => {
    // readPdfText and readWordText are the only ways a PDF's or Word document's text outside a table leaves the parse
    // code; only the AI text thread calls them, and only the TownwiseAI reader, the item reader and that thread import
    // its runner. files/items.ts reads a PDF, Word or Excel file a person attached to a TownwiseAI message and sent:
    // attaching it and pressing Send is that turn's consent (D36), and the item reader is the door chat/* reads it
    // through (ctx.items.readForModel).
    const imports = (file: { path: string; text: string }): string[] => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
      .map((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')));
    expect(sourceFiles().filter((file) => imports(file).includes('files/parse/ai-text.ts')).map((file) => file.path).sort())
      .toEqual(['files/ai-reader.ts', 'files/items.ts', 'files/parse/ai-text-thread.ts']);
    for (const call of ['readPdfText(', 'readWordText(']) {
      const callers = sourceFiles().filter((file) => file.text.includes(call)).map((file) => file.path).sort();
      expect(callers.filter((path) => path !== 'files/parse/pdf.ts' && path !== 'files/parse/docx.ts')).toEqual(['files/parse/ai-text-thread.ts']);
    }
  });

  it('only access/policy.ts mints the lab callback’s scope, and only lab/callback.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForLabCallback(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'lab/callback.ts']);
  });

  it('only access/policy.ts mints the sweep’s scope, and only files/sweeper.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForSweep(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'files/sweeper.ts']);
  });

  it('only access/policy.ts mints the calendar refresh’s scope, and only calendar/refresher.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForCalendarRefresh(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'calendar/refresher.ts']);
  });

  it('only the calendar routes and the refresh loop open a calendar link’s address or read one back from the store, and only the routes seal one', () => {
    const importers = sourceFiles()
      .filter((file) => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'calendar/secret.ts'))
      .map((file) => file.path)
      .sort();
    expect(importers).toEqual(['calendar/refresher.ts', 'handlers/owner-calendars.ts']);
    expect(sourceFiles().filter((file) => file.path !== 'calendar/secret.ts' && /\bseal\(/.test(file.text)).map((file) => file.path))
      .toEqual(['handlers/owner-calendars.ts']);
    expect(sourceFiles().filter((file) => file.text.includes('.sealedAddress(')).map((file) => file.path).sort())
      .toEqual(['calendar/refresher.ts', 'handlers/owner-calendars.ts']);
  });

  it('handlers reach a calendar link only through ctx.calendarFetcher: only app.ts and the refresh loop build one, and only calendar/fetch.ts opens a connection', () => {
    const importers = sourceFiles()
      .filter((file) => [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'calendar/fetch.ts'))
      .map((file) => file.path)
      .sort();
    expect(importers).toEqual(['app.ts', 'calendar/refresher.ts']);
    const sockets = sourceFiles().filter((file) => /from 'node:(?:https?|http2|net|tls|dgram)'/.test(file.text)).map((file) => file.path);
    expect(sockets).toEqual(['calendar/fetch.ts']);
  });

  it('only the calendar routes, the refresh loop, TownwiseAI’s calendar tool and the deletions reach stored calendars, so no forecast code reads them', () => {
    // A value import of the store, a read of stores.ownerCalendars (dotted, destructured or bracketed) or a collection by name.
    const reaches = (file: { path: string; text: string }): boolean => /\bownerCalendars\b|\btw_calendar_/.test(file.text)
      || [...file.text.matchAll(/^import (?!type )[^;]*from '(\.[^']+)';/gm)]
        .some((match) => posix.normalize(posix.join(posix.dirname(file.path), match[1] ?? '')) === 'stores/owner-calendars.ts');
    // The owner-calendar spec: a stored event changes no forecast figure, so forecasts/*, lab/*, people-in-town/* and the
    // estimates and forecast-run handlers stay off this list.
    expect(sourceFiles().filter(reaches).map((file) => file.path).sort()).toEqual([
      'calendar/refresher.ts', 'chat/tools/owner-calendar.ts', 'handlers/deletion.ts', 'handlers/locations.ts', 'handlers/owner-calendars.ts',
      'stores/cross-tenant.ts', 'stores/index.ts', 'stores/owner-calendars.ts',
    ]);
  });

  it('only access/policy.ts mints the open-as-admin scope, and only access/resolve.ts asks for it', () => {
    const callers = sourceFiles().filter((file) => file.text.includes('scopeForOpenAsAdmin(')).map((file) => file.path).sort();
    expect(callers).toEqual(['access/policy.ts', 'access/resolve.ts']);
  });
});
