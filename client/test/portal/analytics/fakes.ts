import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { Calendar, HistoryUpload, SalesHistory, TownEvent } from '../../../src/portal/analytics/api';
import type { DayRecord } from '../../../src/portal/analytics/history';
import type { Note } from '../../../src/portal/locations/api';
import { addDays } from '../../../src/portal/locations/dates';
import type { Coverage } from '../../../src/portal/schemas';

// Synthetic fixtures for the Analytics compute tests: days, notes, town events, the two response bodies, and an
// ApiClient that answers GET .../sales/history and .../calendar from fields and records each path. Every figure
// and address here is made up; ids are low-entropy so the secret scanner never mistakes one for a key.

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const OWNER_EMAIL = 'owner@example.com';

export function day(date: string, guests: number | null, netSalesCents: number | null = guests === null ? null : guests * 2000, upload = 0): DayRecord {
  return { date, guests, netSalesCents, upload };
}

/** One record per day from `from` to `to`; `value` returns guests (net sales follow at $20 a guest), or null to skip. */
export function run(from: string, to: string, value: (date: string, index: number) => number | null): DayRecord[] {
  const out: DayRecord[] = [];
  for (let date = from, index = 0; date <= to; date = addDays(date, 1), index += 1) {
    const guests = value(date, index);
    if (guests !== null) out.push(day(date, guests));
  }
  return out;
}

let noteCount = 0;

export function note(fields: Partial<Note> & Pick<Note, 'startDate'>): Note {
  noteCount += 1;
  return {
    id: `note-${String(noteCount).padStart(4, '0')}`,
    kind: 'private_event',
    endDate: fields.startDate,
    weekdays: null,
    effect: 'more_guests',
    expectedGuests: null,
    detail: null,
    createdByEmail: OWNER_EMAIL,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
    canEdit: true,
    ...fields,
  };
}

export function holiday(date: string, title: string, group: string, groupLabel: string): TownEvent {
  return {
    id: `${group}:${date.slice(0, 4)}`,
    title,
    start: date,
    end: date,
    kind: 'holiday',
    scope: 'national',
    group,
    groupLabel,
    sources: [{ label: 'U.S. Office of Personnel Management', url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/' }],
  };
}

export function townEvent(fields: Partial<TownEvent> & Pick<TownEvent, 'start' | 'title'>): TownEvent {
  return {
    id: `hanover-nh:${fields.start}:event`,
    end: fields.start,
    kind: 'event',
    scope: 'town',
    group: null,
    groupLabel: null,
    sources: [{ label: 'home.dartmouth.edu', url: 'https://home.dartmouth.edu/' }],
    ...fields,
  };
}

export function upload(fields: Partial<HistoryUpload> = {}): HistoryUpload {
  return {
    id: '00000000-0000-0000-0000-00000000a001',
    uploadedAt: '2026-11-04T15:00:00.000Z',
    uploadedByEmail: OWNER_EMAIL,
    status: 'applied',
    firstDate: '2024-01-01',
    lastDate: '2026-11-04',
    file: null,
    ...fields,
  };
}

export function coverageOf(days: readonly DayRecord[]): Coverage {
  const first = days[0]?.date ?? null;
  const last = days.at(-1)?.date ?? null;
  const span = first === null || last === null ? 0 : Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1;
  return {
    dayCount: days.length,
    guestsDayCount: days.filter((each) => each.guests !== null).length,
    netSalesDayCount: days.filter((each) => each.netSalesCents !== null).length,
    firstDate: first,
    lastDate: last,
    missingDays: span - days.length,
  };
}

/** The route's body for these days, which must be oldest first. */
export function historyBody(days: readonly DayRecord[], uploads: readonly HistoryUpload[] = [upload()]): SalesHistory {
  return {
    coverage: coverageOf(days),
    days: {
      date: days.map((each) => each.date),
      guests: days.map((each) => each.guests),
      netSalesCents: days.map((each) => each.netSalesCents),
      upload: days.map((each) => each.upload),
    },
    uploads: [...uploads],
  };
}

export function calendarBody(fields: Partial<Calendar> = {}): Calendar {
  return {
    town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
    researched: true,
    covers: { from: '2026-09-14', to: '2027-01-05' },
    events: [],
    ...fields,
  };
}

export interface AnalyticsFake extends ApiClient {
  /** Bodies by path; an ApiError rejects. */
  answers: Record<string, unknown>;
  paths: string[];
}

export function analyticsFake(answers: Record<string, unknown> = {}): AnalyticsFake {
  const refuse = (): Promise<never> => Promise.reject(new ApiError('http', 'not_found', { status: 404, code: 'not_found' }));
  const fake: AnalyticsFake = {
    answers,
    paths: [],
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      fake.paths.push(path);
      if ((opts?.method ?? 'GET') !== 'GET') return refuse();
      const answer = fake.answers[path];
      if (answer instanceof ApiError) return Promise.reject(answer);
      if (answer === undefined) return refuse();
      return Promise.resolve(schema.parse(answer));
    },
    request: refuse,
    stream: refuse,
    logout: () => Promise.resolve(),
  };
  return fake;
}
