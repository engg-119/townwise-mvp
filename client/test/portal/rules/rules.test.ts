import { checkNote, emptyDraft, NOTE_COPY, type NoteDraft } from '../../../src/portal/locations/noteRules';
import { ruleSchema, rulesSchema, type RuleSchedule } from '../../../src/portal/rules/api';
import {
  changesForecast, checkSchedule, counterLine, draftOfSchedule, forecastLine, normalizeRule, RULE_CHARS, RULE_LIMIT, RULES_COPY, ruleProblem,
} from '../../../src/portal/rules/rules';

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
    // A rule with a schedule (D31) keeps it and its summary.
    const scheduled = { ...rule, schedule: CLOSED_MONDAYS, scheduleSummary: 'Closed on Mondays from Jan 5, 2027' };
    expect(ruleSchema.parse(scheduled)).toEqual(scheduled);
    expect(ruleSchema.parse({ ...rule, schedule: null, scheduleSummary: null })).toEqual({ ...rule, schedule: null, scheduleSummary: null });
  });
});

const TODAY = '2026-11-12';
const CLOSED_MONDAYS: RuleSchedule = {
  kind: 'closure', startDate: '2027-01-05', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
};

function draft(patch: Partial<NoteDraft>): NoteDraft {
  return { ...emptyDraft('closure'), startDate: '2027-01-05', ...patch };
}

describe('a rule’s schedule (D31)', () => {
  test('checkSchedule takes the note form’s fields: an empty end means no end, and no detail is sent or needed', () => {
    expect(checkSchedule(draft({ weekdays: [1] }), TODAY)).toEqual({ input: CLOSED_MONDAYS });
    expect(checkSchedule(draft({ endDate: '2027-03-01', weekdays: [1] }), TODAY)).toEqual({ input: { ...CLOSED_MONDAYS, endDate: '2027-03-01' } });
    // An Other schedule needs no details: the rule says what it is. Details typed before are never sent.
    expect(checkSchedule(draft({ kind: 'other', effect: 'fewer_guests', detail: 'Smith party' }), TODAY)).toEqual({
      input: { ...CLOSED_MONDAYS, kind: 'other', effect: 'fewer_guests', weekdays: null },
    });
    // A party with its count and hours.
    expect(checkSchedule(draft({
      kind: 'private_event', effect: 'more_guests', expectedGuests: '40', weekdays: [5], startTime: '18:00', endTime: '21:00',
    }), TODAY)).toEqual({
      input: { ...CLOSED_MONDAYS, kind: 'private_event', effect: 'more_guests', expectedGuests: 40, weekdays: [5], startTime: '18:00', endTime: '21:00' },
    });
  });

  test('checkSchedule refuses what checkNote refuses, with the same messages', () => {
    const bad: Partial<NoteDraft>[] = [
      { startDate: '' }, { startDate: '2027-13-01' }, { startDate: '2009-12-31' }, { endDate: '2027-01-04' }, { endDate: '2028-01-07' },
      { kind: 'private_event', effect: 'more_guests', expectedGuests: '0' }, { kind: 'private_event', effect: 'more_guests', startTime: '18:00' },
      { kind: 'private_event', effect: 'more_guests', startTime: '21:00', endTime: '18:00' },
    ];
    for (const patch of bad) {
      const checked = checkSchedule(draft(patch), TODAY);
      expect('messages' in checked).toBe(true);
      expect(checked).toEqual(checkNote(draft({ ...patch, detail: 'x' }), TODAY));
    }
    expect(checkSchedule(draft({ startDate: '' }), TODAY)).toEqual({ messages: { startDate: NOTE_COPY.start } });
  });

  test('draftOfSchedule fills the form from a saved schedule, an ongoing one with an empty end', () => {
    expect(draftOfSchedule(CLOSED_MONDAYS)).toEqual({ ...emptyDraft('closure'), startDate: '2027-01-05', weekdays: [1] });
    expect(checkSchedule(draftOfSchedule({ ...CLOSED_MONDAYS, endDate: '2027-01-05' }), TODAY)).toEqual({ input: { ...CLOSED_MONDAYS, endDate: '2027-01-05' } });
  });

  test('changesForecast mirrors the forecast read (api/src/forecasts/adjust.ts): closures, buyouts and counted private events', () => {
    const party = { ...CLOSED_MONDAYS, kind: 'private_event' as const, effect: 'more_guests' as const, expectedGuests: 40 };
    expect([
      CLOSED_MONDAYS, { ...CLOSED_MONDAYS, kind: 'other' as const }, { ...party, effect: 'closed' as const }, party,
      { ...party, expectedGuests: null }, { ...party, effect: 'fewer_guests' as const }, { ...party, kind: 'opening' as const },
    ].map(changesForecast)).toEqual([true, true, true, true, false, false, false]);
  });

  test('each rule says whether it changes the forecast, in words the page shows under it', () => {
    const rule = { schedule: null, scheduleSummary: null };
    expect(forecastLine(rule)).toBe('TownwiseAI reads this. It doesn’t change the forecast.');
    expect(forecastLine({ schedule: CLOSED_MONDAYS, scheduleSummary: 'Closed on Mondays from Jan 5, 2027' }))
      .toBe('Changes the forecast: Closed on Mondays from Jan 5, 2027');
    expect(forecastLine({ schedule: { ...CLOSED_MONDAYS, kind: 'opening', effect: 'more_guests' }, scheduleSummary: 'Opening, more guests than usual on Mondays from Jan 5, 2027' }))
      .toBe('On the calendar: Opening, more guests than usual on Mondays from Jan 5, 2027. Only closures, buyouts and private events with a guest count change the forecast.');
    // An API from before schedules: no schedule.
    expect(forecastLine({})).toBe('TownwiseAI reads this. It doesn’t change the forecast.');
  });
});
