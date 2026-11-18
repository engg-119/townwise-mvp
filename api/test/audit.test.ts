// The weekly refresh's audit events (D42), without Docker: each action's allowlist holds ids only, and the console's
// summary words each one.
import { describe, expect, it } from 'vitest';

import { summaryOf } from '../src/audit.ts';
import { AUDIT_DETAIL_KEYS } from '../src/stores/audit-events.ts';

describe('the weekly refresh’s audit events', () => {
  it('allow ids only: a scheduled start names its location and calibration, the pause nothing', () => {
    expect(AUDIT_DETAIL_KEYS['calibration.scheduled']).toEqual(['locationId', 'calibrationId']);
    expect(AUDIT_DETAIL_KEYS['forecast_schedule.paused']).toEqual([]);
    expect(AUDIT_DETAIL_KEYS['forecast_schedule.resumed']).toEqual([]);
  });

  it('read in plain words in the console', () => {
    expect(summaryOf('calibration.scheduled', { locationId: 'l1', calibrationId: 'c1' })).toBe('Townwise started its weekly calibration');
    expect(summaryOf('forecast_schedule.paused', {})).toBe('Paused Townwise’s weekly forecast refresh for every organization');
    expect(summaryOf('forecast_schedule.resumed', {})).toBe('Resumed Townwise’s weekly forecast refresh for every organization');
  });
});

describe('the weekly suggestions’ audit events', () => {
  it('allow the switch’s state, and ids and the type of a decided suggestion: never its dates, words or why', () => {
    expect(AUDIT_DETAIL_KEYS['org.weekly_suggestions_changed']).toEqual(['on']);
    expect(AUDIT_DETAIL_KEYS['agent.suggestion_accepted']).toEqual(['locationId', 'suggestionId', 'type', 'source', 'edited']);
    expect(AUDIT_DETAIL_KEYS['agent.suggestion_dismissed']).toEqual(['locationId', 'suggestionId', 'type', 'source']);
  });

  it('read in plain words in the console', () => {
    expect(summaryOf('org.weekly_suggestions_changed', { on: false })).toBe('Turned TownwiseAI’s weekly suggestions off');
    expect(summaryOf('org.weekly_suggestions_changed', { on: true })).toBe('Turned TownwiseAI’s weekly suggestions on');
    expect(summaryOf('agent.suggestion_accepted', { type: 'note' })).toBe('Accepted a note TownwiseAI suggested');
    expect(summaryOf('agent.suggestion_dismissed', { type: 'rule' })).toBe('Dismissed a business rule TownwiseAI suggested');
  });
});

describe('suggested closure rules’ audit events (D46)', () => {
  it('allow counts on a read and its undo, and the source and whether it was edited on a decision', () => {
    expect(AUDIT_DETAIL_KEYS['file.ai_read']).toContain('rulesSuggested');
    expect(AUDIT_DETAIL_KEYS['file.ai_undone']).toEqual(['locationId', 'notes', 'days', 'items', 'suggestions']);
  });

  it('read in plain words in the console', () => {
    expect(summaryOf('file.ai_read', { kind: 'menu', events: 0, days: 0, notes: 0, daysWritten: 0, item: true, rulesSuggested: 2 }))
      .toBe('TownwiseAI read a file (a menu): 0 dated events, 0 days; it added 0 notes and 0 days and kept its notes on the file, and suggested 2 business rules');
    expect(summaryOf('file.ai_read', { kind: 'menu', events: 0, days: 0, notes: 1, daysWritten: 0, item: false, rulesSuggested: 0 }))
      .toBe('TownwiseAI read a file (a menu): 0 dated events, 0 days; it added 1 notes and 0 days');
    expect(summaryOf('file.ai_undone', { notes: 1, days: 0, items: 1, suggestions: 2 }))
      .toBe('Undid what TownwiseAI made from a file: 1 notes, 0 days, 1 items and 2 suggested rules still waiting');
    expect(summaryOf('file.ai_undone', { notes: 1, days: 0, items: 1 })).toBe('Undid what TownwiseAI made from a file: 1 notes, 0 days and 1 items');
    expect(summaryOf('agent.suggestion_accepted', { type: 'rule', source: 'file', edited: true }))
      .toBe('Accepted, edited, a business rule TownwiseAI suggested from a file');
    expect(summaryOf('agent.suggestion_accepted', { type: 'rule', source: 'sales', edited: false }))
      .toBe('Accepted a business rule TownwiseAI suggested from the sales history');
    expect(summaryOf('agent.suggestion_dismissed', { type: 'rule', source: 'file' })).toBe('Dismissed a business rule TownwiseAI suggested from a file');
  });
});
