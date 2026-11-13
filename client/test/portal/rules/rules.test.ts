import { ruleSchema, rulesSchema } from '../../../src/portal/rules/api';
import { counterLine, normalizeRule, RULE_CHARS, RULE_LIMIT, RULES_COPY, ruleProblem } from '../../../src/portal/rules/rules';

// The business rule text rule (spec 10.16), the client's mirror of api/src/handlers/rules.ts ruleTextOf: the same
// cases as api/test/business-rules.test.ts, so the page refuses exactly what the API would.

describe('business rules', () => {
  test('normalizeRule collapses whitespace', () => {
    expect(normalizeRule('  Closed   Mondays ')).toBe('Closed Mondays');
    expect(normalizeRule('Closed\nMondays\r\n\tall winter')).toBe('Closed Mondays all winter');
    expect(normalizeRule('Café opens at 7')).toBe('Café opens at 7');
  });

  test('ruleProblem matches the API’s rule', () => {
    expect(RULE_LIMIT).toBe(30);
    expect(RULE_CHARS).toBe(200);
    for (const empty of ['', '   ', '\n\t']) expect(ruleProblem(empty)).toBe(RULES_COPY.empty);
    expect(ruleProblem('a'.repeat(201))).toBe(RULES_COPY.long);
    expect(ruleProblem('🍕'.repeat(201))).toBe(RULES_COPY.long);
    for (const special of ['Closed\u0000Mondays', 'Closed\u0007', 'Closed​Mondays', 'Closed‮Mondays']) {
      expect(ruleProblem(special)).toBe(RULES_COPY.special);
    }
    // 200 code points, an emoji counting as one, and a decomposed é that NFC makes one.
    for (const fine of ['Closed Mondays', 'a'.repeat(200), '🍕'.repeat(200), `${'a'.repeat(199)}é`, ` ${'a'.repeat(200)}\n`]) {
      expect(ruleProblem(fine)).toBeNull();
    }
    expect(RULES_COPY).toMatchObject({ empty: 'Write the rule.', long: 'Keep it to 200 characters.' });
  });

  test('the counter shows from 180 characters', () => {
    expect(counterLine('a'.repeat(179))).toBeNull();
    expect(counterLine('a'.repeat(180))).toBe('180 of 200 characters');
    expect(counterLine('🍕'.repeat(205))).toBe('205 of 200 characters');
  });

  test('the API’s rule shape parses, and unknown keys are dropped', () => {
    const rule = {
      id: 'r1', text: 'Closed Mondays', addedVia: 'page', createdByEmail: 'owner@example.com', createdAt: '2026-03-02T15:00:00.000Z',
      updatedAt: '2026-03-02T15:00:00.000Z', canEdit: true,
    };
    expect(ruleSchema.parse({ ...rule, extra: 1 })).toEqual(rule);
    expect(rulesSchema.parse({ rules: [rule], limit: 30 })).toEqual({ rules: [rule], limit: 30 });
    expect(() => ruleSchema.parse({ ...rule, addedVia: 'email' })).toThrow();
  });
});
