import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { Rule, RuleSchedule, RuleSuggestion } from '../../../src/portal/rules/api';
import { normalizeRule } from '../../../src/portal/rules/rules';
import { ADMIN_EMAIL, EMAIL, refusal } from '../../helpers/portal';

// The Business rules routes (spec 10.16) for fakePortalApi's `fallback`: GET .../rules answers `rules` (a list, an
// ApiError, or a promise of either) with the 30 limit; POST, PATCH and DELETE change the list as the API would, a
// schedule included (its summary is fakeSummary's, not the API's words). A write answers an ApiError instead when
// `fail` has one for it, keyed "METHOD /path". D46: GET also answers `suggested`, and POST
// .../agent/rule-suggestions/:id/accept or /dismiss take a suggestion out of it, accept saving its rule (or the body's
// edited one) under the suggestion's id, as the API does (a `sales_weekday_` one under a new stored id).

export interface RulesFake extends ApiClient {
  rules: Rule[] | ApiError | Promise<Rule[] | ApiError>;
  suggested: RuleSuggestion[];
  fail: Record<string, () => ApiError>;
}

const PATH = /^\/api\/org\/locations\/l1\/rules(?:\/([^/]+))?$/;
const DECIDE = /^\/api\/org\/locations\/l1\/agent\/rule-suggestions\/([^/]+)\/(accept|dismiss)$/;

/** A suggested closure rule from a file, in the API's shape (api/src/agent/rule-suggestion-views.ts). */
export function suggestionOf(id: string, text: string, extra?: Partial<RuleSuggestion>): RuleSuggestion {
  return {
    id, source: 'file', text,
    schedule: { kind: 'closure', startDate: '2026-11-17', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    scheduleSummary: `${text} from Nov 17, 2026`, file: { ref: 'f_1', title: 'Hours.pdf' }, evidence: null, canDecide: true, ...extra,
  };
}

export function ruleOf(id: string, text: string, extra?: Partial<Rule>): Rule {
  return {
    id, text, addedVia: 'page', createdByEmail: ADMIN_EMAIL, createdAt: '2026-03-02T15:00:00.000Z', updatedAt: '2026-03-02T15:00:00.000Z',
    canEdit: true, ...extra,
  };
}

/** The fake's summary of a schedule; the API words its own (api/src/forecasts/reasons.ts scheduleSummary). */
export function fakeSummary(schedule: RuleSchedule | null): string | null {
  return schedule === null ? null : `Closed on Tuesdays from ${schedule.startDate}`;
}

/** `count` rules, r1 first. */
export function manyRules(count: number): Rule[] {
  return Array.from({ length: count }, (_, index) => ruleOf(`r${String(index + 1)}`, `Rule number ${String(index + 1)}`));
}

export function rulesFake(rules: RulesFake['rules'] = [], suggested: RuleSuggestion[] = []): RulesFake {
  let next = 100;
  const list = (): Rule[] => {
    if (!Array.isArray(fake.rules)) throw new Error('the list is not loaded');
    return fake.rules;
  };
  const fake: RulesFake = {
    rules,
    suggested,
    fail: {},
    async json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      const failure = fake.fail[`${method} ${path}`];
      if (failure !== undefined) throw failure();
      const decide = DECIDE.exec(path);
      if (decide !== null && method === 'POST') return schema.parse(decided(decide[1] ?? '', decide[2] === 'accept', opts?.body));
      const match = PATH.exec(path);
      if (match === null) throw refusal(404, 'not_found');
      const id = match[1];
      if (method === 'GET' && id === undefined) {
        const answer = await fake.rules;
        if (answer instanceof ApiError) throw answer;
        return schema.parse({ rules: answer, limit: 30, suggested: fake.suggested });
      }
      const body = opts?.body as { text?: string; schedule?: RuleSchedule | null } | undefined;
      const text = normalizeRule(body?.text ?? '');
      const schedule = body?.schedule ?? null;
      if (method === 'POST' && id === undefined) {
        next += 1;
        const rule = ruleOf(`r${String(next)}`, text, {
          createdByEmail: EMAIL, createdAt: '2026-11-04T15:00:00.000Z', updatedAt: '2026-11-04T15:00:00.000Z',
          ...(body?.schedule === undefined ? {} : { schedule, scheduleSummary: fakeSummary(schedule) }),
        });
        fake.rules = [...list(), rule];
        return schema.parse({ rule });
      }
      const existing = list().find((rule) => rule.id === id);
      if (method === 'PATCH' && existing !== undefined) {
        const rule = {
          ...existing, updatedAt: '2026-11-04T16:00:00.000Z', ...(body?.text === undefined ? {} : { text }),
          ...(body?.schedule === undefined ? {} : { schedule, scheduleSummary: fakeSummary(schedule) }),
        };
        fake.rules = list().map((other) => (other.id === id ? rule : other));
        return schema.parse({ rule });
      }
      throw refusal(404, 'not_found');
    },
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      const method = opts?.method ?? 'GET';
      const failure = fake.fail[`${method} ${path}`];
      if (failure !== undefined) return Promise.reject(failure());
      const id = PATH.exec(path)?.[1];
      if (method !== 'DELETE' || id === undefined || !list().some((rule) => rule.id === id)) return Promise.reject(refusal(404, 'not_found'));
      fake.rules = list().filter((rule) => rule.id !== id);
      return Promise.resolve({ ok: true, status: 204 } as Response);
    },
    stream: () => Promise.reject(refusal(404, 'not_found')),
    logout: () => Promise.resolve(),
  };
  /** A decision the API would answer: the suggestion out of `suggested`, and Confirm's or Edit's rule saved. */
  function decided(id: string, accept: boolean, body: unknown): unknown {
    const suggestion = fake.suggested.find((each) => each.id === id);
    if (suggestion === undefined) throw refusal(404, 'not_found');
    fake.suggested = fake.suggested.filter((each) => each.id !== id);
    const stored = id.startsWith('sales_weekday_') ? 'r900' : id;
    if (!accept) return { suggestion: { id: stored, status: 'dismissed' }, rule: null };
    const edited = (body as { rule?: { text: string; schedule: RuleSchedule | null } }).rule;
    const schedule = edited === undefined ? suggestion.schedule : edited.schedule;
    const rule = ruleOf(stored, edited?.text ?? suggestion.text, {
      addedVia: 'townwise_ai', createdByEmail: EMAIL, createdAt: '2026-11-17T15:00:00.000Z', updatedAt: '2026-11-17T15:00:00.000Z',
      schedule, scheduleSummary: edited === undefined ? suggestion.scheduleSummary : fakeSummary(schedule),
    });
    fake.rules = [...list(), rule];
    return { suggestion: { id: stored, status: 'accepted' }, rule };
  }

  return fake;
}
