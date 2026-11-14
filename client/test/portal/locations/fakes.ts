import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { Note, Sales, SalesDay, Upload } from '../../../src/portal/locations/api';
import { addDays, daysBetween } from '../../../src/portal/locations/dates';
import type { Coverage } from '../../../src/portal/schemas';
import { ADMIN_EMAIL, refusal } from '../../helpers/portal';

// The location pages' reads, for fakePortalApi's `fallback`: GET .../sales, .../sales/days and .../notes answer
// from these fields (a value, an ApiError, or a promise of either), and DELETE answers 204 unless `deletes` says
// otherwise. Writes the portal fake answers itself (POST, PATCH and DELETE through api.json) go in its `answers`.
// The fixtures compute coverage and month sums the way api/src/stores/sales-days.ts does.

export interface LocationsFake extends ApiClient {
  sales: Record<string, unknown>;
  days: Record<string, SalesDay[]>;
  notes: Record<string, unknown>;
  /** DELETE by request(): an ApiError to answer with, or null for 204. */
  deletes: Record<string, () => ApiError | null>;
  dayRanges: { locationId: string; from: string; to: string }[];
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  if (resolved === undefined) throw refusal(404, 'not_found');
  return schema.parse(resolved);
}

export function locationsFake(init?: Partial<Pick<LocationsFake, 'sales' | 'days' | 'notes'>>): LocationsFake {
  const fake: LocationsFake = {
    sales: init?.sales ?? {},
    days: init?.days ?? {},
    notes: init?.notes ?? {},
    deletes: {},
    dayRanges: [],
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      if ((opts?.method ?? 'GET') !== 'GET') return Promise.reject(refusal(404, 'not_found'));
      const sales = /^\/api\/org\/locations\/([^/]+)\/sales$/.exec(path);
      if (sales?.[1] !== undefined) return settle(fake.sales[sales[1]], schema);
      const days = /^\/api\/org\/locations\/([^/]+)\/sales\/days\?from=([\d-]+)&to=([\d-]+)$/.exec(path);
      if (days?.[1] !== undefined && days[2] !== undefined && days[3] !== undefined) {
        const [, locationId, from, to] = days;
        fake.dayRanges.push({ locationId, from, to });
        return settle({ days: (fake.days[locationId] ?? []).filter((day) => day.date >= from && day.date <= to) }, schema);
      }
      const notes = /^\/api\/org\/locations\/([^/]+)\/notes$/.exec(path);
      if (notes?.[1] !== undefined) {
        const value = fake.notes[notes[1]];
        return settle(value instanceof ApiError || value === undefined ? value : Promise.resolve(value).then((list) => ({ notes: list })), schema);
      }
      return Promise.reject(refusal(404, 'not_found'));
    },
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      if (opts?.method !== 'DELETE') return Promise.reject(refusal(404, 'not_found'));
      const error = fake.deletes[path]?.() ?? null;
      if (error !== null) return Promise.reject(error);
      return Promise.resolve({ ok: true, status: 204 } as Response);
    },
    stream: () => Promise.reject(refusal(404, 'not_found')),
    logout: () => Promise.resolve(),
  };
  return fake;
}

/** `count` days from `from`, with the values `values(index)` gives (null for a day with no row). */
export function daysOf(
  from: string,
  count: number,
  values: (index: number) => { guests: number | null; netSalesCents: number | null } | null,
): SalesDay[] {
  const days: SalesDay[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = values(index);
    if (value !== null) days.push({ date: addDays(from, index), ...value });
  }
  return days;
}

export function coverageOf(days: readonly SalesDay[]): Coverage {
  const withValue = days.filter((day) => day.guests !== null || day.netSalesCents !== null);
  const first = withValue[0]?.date ?? null;
  const last = withValue.at(-1)?.date ?? null;
  return {
    dayCount: withValue.length,
    guestsDayCount: withValue.filter((day) => day.guests !== null).length,
    netSalesDayCount: withValue.filter((day) => day.netSalesCents !== null).length,
    firstDate: first,
    lastDate: last,
    missingDays: first === null || last === null ? 0 : daysBetween(first, last) + 1 - withValue.length,
  };
}

export function uploadOf(id: string, extra?: Partial<Upload>): Upload {
  return {
    id, uploadedAt: '2026-02-05T15:00:00.000Z', uploadedByEmail: ADMIN_EMAIL, status: 'applied', dayCount: 400, inserted: 400,
    replaced: 0, kept: 0, firstDate: '2025-01-01', lastDate: '2026-02-04', ...extra,
  };
}

/** GET .../sales for these days, as the API computes it. */
export function salesOf(days: readonly SalesDay[], uploads: Upload[] = []): Sales {
  const coverage = coverageOf(days);
  const months = new Map<string, { dayCount: number; guests: number | null; netSalesCents: number | null }>();
  for (const day of days) {
    if (day.guests === null && day.netSalesCents === null) continue;
    const month = day.date.slice(0, 7);
    const sum = months.get(month) ?? { dayCount: 0, guests: null, netSalesCents: null };
    months.set(month, {
      dayCount: sum.dayCount + 1,
      guests: day.guests === null ? sum.guests : (sum.guests ?? 0) + day.guests,
      netSalesCents: day.netSalesCents === null ? sum.netSalesCents : (sum.netSalesCents ?? 0) + day.netSalesCents,
    });
  }
  return {
    coverage,
    calibration: coverage.firstDate === null || coverage.lastDate === null
      ? { state: 'no_sales_data' }
      : { state: 'not_calibrated', dayCount: coverage.dayCount, firstDate: coverage.firstDate, lastDate: coverage.lastDate },
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, sum]) => ({ month, ...sum })),
    uploads,
  };
}

export function noteOf(id: string, extra?: Partial<Note>): Note {
  return {
    id, kind: 'closure', startDate: '2026-03-02', endDate: '2026-03-02', weekdays: null, effect: 'closed', expectedGuests: null,
    detail: null, startTime: null, endTime: null, createdByEmail: ADMIN_EMAIL, createdAt: '2026-02-01T15:00:00.000Z', updatedAt: '2026-02-01T15:00:00.000Z',
    canEdit: true, ...extra,
  };
}
