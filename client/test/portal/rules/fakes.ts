import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { Rule } from '../../../src/portal/rules/api';
import { normalizeRule } from '../../../src/portal/rules/rules';
import { ADMIN_EMAIL, EMAIL, refusal } from '../../helpers/portal';

// The Business rules routes (spec 10.16) for fakePortalApi's `fallback`: GET .../rules answers `rules` (a list, an
// ApiError, or a promise of either) with the 30 limit; POST, PATCH and DELETE change the list as the API would. A
// write answers an ApiError instead when `fail` has one for it, keyed "METHOD /path".

export interface RulesFake extends ApiClient {
  rules: Rule[] | ApiError | Promise<Rule[] | ApiError>;
  fail: Record<string, () => ApiError>;
}

const PATH = /^\/api\/org\/locations\/l1\/rules(?:\/([^/]+))?$/;

export function ruleOf(id: string, text: string, extra?: Partial<Rule>): Rule {
  return {
    id, text, addedVia: 'page', createdByEmail: ADMIN_EMAIL, createdAt: '2026-03-02T15:00:00.000Z', updatedAt: '2026-03-02T15:00:00.000Z',
    canEdit: true, ...extra,
  };
}

/** `count` rules, r1 first. */
export function manyRules(count: number): Rule[] {
  return Array.from({ length: count }, (_, index) => ruleOf(`r${String(index + 1)}`, `Rule number ${String(index + 1)}`));
}

export function rulesFake(rules: RulesFake['rules'] = []): RulesFake {
  let next = 100;
  const list = (): Rule[] => {
    if (!Array.isArray(fake.rules)) throw new Error('the list is not loaded');
    return fake.rules;
  };
  const fake: RulesFake = {
    rules,
    fail: {},
    async json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      const match = PATH.exec(path);
      if (match === null) throw refusal(404, 'not_found');
      const failure = fake.fail[`${method} ${path}`];
      if (failure !== undefined) throw failure();
      const id = match[1];
      if (method === 'GET' && id === undefined) {
        const answer = await fake.rules;
        if (answer instanceof ApiError) throw answer;
        return schema.parse({ rules: answer, limit: 30 });
      }
      const text = normalizeRule((opts?.body as { text: string } | undefined)?.text ?? '');
      if (method === 'POST' && id === undefined) {
        next += 1;
        const rule = ruleOf(`r${String(next)}`, text, { createdByEmail: EMAIL, createdAt: '2026-11-04T15:00:00.000Z', updatedAt: '2026-11-04T15:00:00.000Z' });
        fake.rules = [...list(), rule];
        return schema.parse({ rule });
      }
      const existing = list().find((rule) => rule.id === id);
      if (method === 'PATCH' && existing !== undefined) {
        const rule = { ...existing, text, updatedAt: '2026-11-04T16:00:00.000Z' };
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
  return fake;
}
