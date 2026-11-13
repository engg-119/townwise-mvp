// The business rule text rule (spec 10.16, D31), the client's mirror of api/src/handlers/rules.ts ruleTextOf: NFC,
// every run of whitespace one space, trimmed, then 1 to 200 code points with no control or format character. The page
// checks it before it sends, so the API's 400 is only a fallback. Pinned by test/portal/rules/rules.test.ts.

/** [CONFIRM: 30 business rules per location, 200 characters each] */
export const RULE_LIMIT = 30;
export const RULE_CHARS = 200;
/** The field shows its character count from here on. */
const COUNTER_FROM = 180;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

export const RULES_COPY = {
  empty: 'Write the rule.',
  long: 'Keep it to 200 characters.',
  special: 'Take out the special characters.',
  limit: 'This location has 30 rules, the most it can hold. Delete one to add another.',
  exists: 'That rule is already saved.',
  forbidden: 'Only the person who added this rule or an org admin can change it.',
  gone: 'This rule was deleted.',
  helper: 'One line, up to 200 characters. Leave out guest names.',
} as const;

/** The text as the API stores it. */
export function normalizeRule(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Why the API would refuse this text, in the page's words, or null when it takes it. */
export function ruleProblem(raw: string): string | null {
  const text = normalizeRule(raw);
  const length = Array.from(text).length;
  if (length === 0) return RULES_COPY.empty;
  if (length > RULE_CHARS) return RULES_COPY.long;
  return CONTROL_OR_FORMAT.test(text) ? RULES_COPY.special : null;
}

/** “185 of 200 characters” once the text nears the limit, counted as the API counts; null before. */
export function counterLine(raw: string): string | null {
  const length = Array.from(normalizeRule(raw)).length;
  return length < COUNTER_FROM ? null : `${String(length)} of ${String(RULE_CHARS)} characters`;
}
