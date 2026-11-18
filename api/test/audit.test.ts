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
    expect(AUDIT_DETAIL_KEYS['agent.suggestion_accepted']).toEqual(['locationId', 'suggestionId', 'type']);
    expect(AUDIT_DETAIL_KEYS['agent.suggestion_dismissed']).toEqual(['locationId', 'suggestionId', 'type']);
  });

  it('read in plain words in the console', () => {
    expect(summaryOf('org.weekly_suggestions_changed', { on: false })).toBe('Turned TownwiseAI’s weekly suggestions off');
    expect(summaryOf('org.weekly_suggestions_changed', { on: true })).toBe('Turned TownwiseAI’s weekly suggestions on');
    expect(summaryOf('agent.suggestion_accepted', { type: 'note' })).toBe('Accepted a note TownwiseAI suggested');
    expect(summaryOf('agent.suggestion_dismissed', { type: 'rule' })).toBe('Dismissed a business rule TownwiseAI suggested');
  });
});

describe('the calendar titles switch and the owner-calendar kinds’ audit events (calendar-event-suggestions)', () => {
  it('allow the switch’s state only', () => {
    expect(AUDIT_DETAIL_KEYS['org.calendar_titles_ai_changed']).toEqual(['on']);
  });

  it('read in plain words in the console, by the suggestion’s type', () => {
    expect(summaryOf('org.calendar_titles_ai_changed', { on: false })).toBe('Turned sending calendar event titles to TownwiseAI off');
    expect(summaryOf('org.calendar_titles_ai_changed', { on: true })).toBe('Turned sending calendar event titles to TownwiseAI on');
    expect(summaryOf('agent.suggestion_accepted', { type: 'event' })).toBe('Accepted a private event TownwiseAI spotted on a calendar');
    expect(summaryOf('agent.suggestion_accepted', { type: 'move' })).toBe('Accepted moving a note with its calendar event');
    expect(summaryOf('agent.suggestion_dismissed', { type: 'remove' })).toBe('Dismissed deleting a note whose calendar event went');
  });
});
