import { ConfigError, loadEnv } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import { configSchema, resolveTownwiseConfig } from '../src/config.ts';

function parse(value: string | undefined): readonly string[] {
  return loadEnv(configSchema, { TOWNWISE_SUPERADMIN_EMAILS: value }).TOWNWISE_SUPERADMIN_EMAILS;
}

describe('config', () => {
  it('allows an empty or missing staff list', () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse('')).toEqual([]);
  });

  it('normalizes each address like the kit and drops duplicates and empty entries', () => {
    expect(parse(' Staff@Townwise.TEST, ops@townwise.test,,staff@townwise.test ')).toEqual([
      'staff@townwise.test', 'ops@townwise.test',
    ]);
  });

  it('refuses an entry that is not an email, without echoing it', () => {
    try {
      parse('staff@townwise.test,secret-value-not-an-email');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).toContain('TOWNWISE_SUPERADMIN_EMAILS');
      expect(String(err)).not.toContain('secret-value');
    }
  });

  it('refuses more than 20 addresses', () => {
    const list = Array.from({ length: 21 }, (_, i) => `staff${String(i)}@townwise.test`).join(',');
    expect(() => parse(list)).toThrow(ConfigError);
    expect(parse(list.split(',').slice(0, 20).join(','))).toHaveLength(20);
  });

  it('production refuses an empty staff list; development and test allow it', () => {
    const budget = { TOWNWISE_CHAT_MONTHLY_BUDGET_USD: 20 };
    expect(() => resolveTownwiseConfig({ NODE_ENV: 'production', TOWNWISE_SUPERADMIN_EMAILS: [], ...budget })).toThrow(ConfigError);
    expect(resolveTownwiseConfig({ NODE_ENV: 'development', TOWNWISE_SUPERADMIN_EMAILS: [], ...budget }).superadminEmails.size).toBe(0);
    const resolved = resolveTownwiseConfig({ NODE_ENV: 'production', TOWNWISE_SUPERADMIN_EMAILS: ['staff@townwise.test'], ...budget });
    expect(resolved.superadminEmails.has('staff@townwise.test')).toBe(true);
  });

  it('reads the tuning chat budget in dollars, 20 by default, and refuses a value that is not a number from 0 to 10,000', () => {
    const budget = (value: string | undefined): number =>
      loadEnv(configSchema, { TOWNWISE_CHAT_MONTHLY_BUDGET_USD: value }).TOWNWISE_CHAT_MONTHLY_BUDGET_USD;
    expect(budget(undefined)).toBe(20);
    expect(budget('')).toBe(20);
    expect(budget('35.5')).toBe(35.5);
    expect(budget('0')).toBe(0);
    for (const bad of ['-1', 'twenty', '10001']) expect(() => budget(bad)).toThrow(ConfigError);
  });
});
