import type { z } from 'zod';

import type { ApiClient, RequestOptions } from '../../../src/api/client';
import type { DataItem } from '../../../src/portal/data/api';
import { ADMIN_EMAIL, refusal } from '../../helpers/portal';
import { fileViewOf, filesFake, type FilesFake } from '../files/fakes';

// Your data in the API's shapes (api/src/handlers/data.ts) and a fake ApiClient for its routes. The list and GET of
// one item answer from `items` (the list filtered by locationId, `pageSize` a page, the cursor an offset); PATCH
// (on or off, or a rename keeping the extension), DELETE, POST text and POST replace change `items` and are recorded.
// GET .../sales/history answers from `history` (the item page's days). Anything else goes to the stored-files fake,
// which sits over the location pages' fake.

export function itemOf(ref: string, extra?: Partial<DataItem>): DataItem {
  return {
    ref, locationId: 'l1', via: 'file', kind: 'text', name: `${ref}.txt`, addedAt: '2026-11-05T15:00:00.000Z', addedByEmail: ADMIN_EMAIL,
    sizeBytes: 2048, enabled: true, state: 'used', outcome: null, days: null,
    file: {
      id: ref.replace(/^[uf]_/, 'file-'), hasClean: false, rawAvailable: true, rawExpiresAt: '2027-11-05T15:00:00.000Z', entries: null,
      canDownloadRaw: true, canDownloadClean: false, canDeleteRaw: true,
    },
    canTurnOff: true, canDelete: true, canEdit: false, editedAt: null, editedByEmail: null,
    ...extra,
  };
}

/** A sales upload sent from the browser: no file kept. */
export function dailyTotalsOf(ref: string, extra?: Partial<DataItem>): DataItem {
  return itemOf(ref, {
    via: 'browser', kind: 'daily_totals', name: null, sizeBytes: null, file: null,
    days: { count: 10, inUse: 5, firstDate: '2026-05-01', lastDate: '2026-05-10' },
    ...extra,
  });
}

export interface DataFake extends ApiClient {
  items: DataItem[];
  pageSize: number;
  /** The `locationId` and `after` of every list request, in order. */
  lists: { locationId: string | null; after: string | null }[];
  patches: { ref: string; body: unknown }[];
  removed: { locationId: string; ref: string }[];
  texts: { locationId: string; body: unknown }[];
  /** POST .../data/:ref/replace requests, in order. */
  replaces: { ref: string; body: unknown }[];
  /** GET .../sales/history bodies (or an ApiError) by location id. */
  history: Record<string, unknown>;
  /** Answers by "METHOD path": a body, an ApiError or a promise of either. */
  answers: Record<string, (body: unknown) => unknown>;
  files: FilesFake;
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof Error) throw resolved;
  return schema.parse(resolved);
}

export function dataFake(init: { inner: ApiClient; items?: DataItem[] }): DataFake {
  const files = filesFake({ inner: init.inner });
  files.lists[''] = [];
  const fake: DataFake = {
    items: init.items ?? [],
    pageSize: 100,
    lists: [],
    patches: [],
    removed: [],
    texts: [],
    replaces: [],
    history: {},
    answers: {},
    files,
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      if (method === 'GET' && path.startsWith('/api/org/data')) {
        const query = new URLSearchParams(path.split('?')[1] ?? '');
        const locationId = query.get('locationId');
        const after = query.get('after');
        fake.lists.push({ locationId, after });
        const answer = fake.answers[`GET ${path.split('?')[0] ?? ''}`]?.(undefined);
        if (answer !== undefined) return settle(answer, schema);
        const all = fake.items.filter((item) => locationId === null || item.locationId === locationId);
        const start = after === null ? 0 : Number(after);
        const page = all.slice(start, start + fake.pageSize);
        const next = start + fake.pageSize < all.length ? String(start + fake.pageSize) : null;
        return settle({ items: page, next }, schema);
      }
      const one = /^\/api\/org\/locations\/([^/]+)\/data\/([^/]+)$/.exec(path);
      if (one?.[1] !== undefined && one[2] !== undefined && one[2] !== 'text') {
        const [, locationId, ref] = one;
        const answered = fake.answers[`${method} ${ref}`]?.(opts?.body);
        if (method === 'GET') {
          if (answered !== undefined) return settle(answered, schema);
          const item = fake.items.find((candidate) => candidate.ref === ref && candidate.locationId === locationId);
          return item === undefined ? Promise.reject(refusal(404, 'not_found')) : settle({ item: { ...item } }, schema);
        }
        if (method === 'PATCH') {
          fake.patches.push({ ref, body: opts?.body });
          if (answered !== undefined) return settle(answered, schema);
          const item = fake.items.find((candidate) => candidate.ref === ref);
          if (item === undefined) return Promise.reject(refusal(404, 'not_found'));
          const body = opts?.body as { enabled: boolean } | { title: string };
          if ('title' in body) {
            const dot = item.name?.lastIndexOf('.') ?? -1;
            item.name = `${body.title}${item.name === null || dot === -1 ? '' : item.name.slice(dot)}`;
          } else item.enabled = body.enabled;
          return settle({ item: { ...item } }, schema);
        }
        if (method === 'DELETE') {
          fake.removed.push({ locationId, ref });
          if (answered !== undefined) return settle(answered, schema);
          fake.items = fake.items.filter((candidate) => candidate.ref !== ref);
          return settle({ deletedDays: 5, deletedFiles: 0 }, schema);
        }
      }
      const replace = /^\/api\/org\/locations\/([^/]+)\/data\/([^/]+)\/replace$/.exec(path);
      if (method === 'POST' && replace?.[2] !== undefined) {
        const ref = replace[2];
        fake.replaces.push({ ref, body: opts?.body });
        const answered = fake.answers['POST replace']?.(opts?.body);
        if (answered !== undefined) return settle(answered, schema);
        const old = fake.items.find((candidate) => candidate.ref === ref);
        if (old === undefined) return Promise.reject(refusal(404, 'not_found'));
        // The edit takes the item's place: who added it, when and on or off stay; the ref is the new file's.
        const { fileId } = opts?.body as { fileId: string };
        const item: DataItem = {
          ...old, ref: `f_${fileId}`, file: old.file === null ? null : { ...old.file, id: fileId }, editedAt: '2026-11-11T15:00:00.000Z',
          editedByEmail: ADMIN_EMAIL,
        };
        fake.items = fake.items.map((candidate) => (candidate.ref === ref ? item : candidate));
        return settle({ item }, schema);
      }
      const history = /^\/api\/org\/locations\/([^/]+)\/sales\/history$/.exec(path);
      if (method === 'GET' && history?.[1] !== undefined) {
        const body = fake.history[history[1]];
        return body === undefined ? Promise.reject(refusal(404, 'not_found')) : settle(body, schema);
      }
      const text = /^\/api\/org\/locations\/([^/]+)\/data\/text$/.exec(path);
      if (method === 'POST' && text?.[1] !== undefined) {
        fake.texts.push({ locationId: text[1], body: opts?.body });
        const answered = fake.answers['POST text']?.(opts?.body);
        if (answered !== undefined) return settle(answered, schema);
        const title = (opts?.body as { title: string }).title;
        fake.items = [itemOf('f_text', { name: `${title}.txt`, state: 'kept', outcome: 'reference', via: 'file' }), ...fake.items];
        return settle({ file: fileViewOf('file-text', { name: `${title}.txt`, purpose: 'reference', importId: null }) }, schema);
      }
      return files.json(path, schema, opts);
    },
    request: (path, opts) => files.request(path, opts),
    stream: (path, opts) => files.stream(path, opts),
    logout: () => Promise.resolve(),
  };
  return fake;
}

