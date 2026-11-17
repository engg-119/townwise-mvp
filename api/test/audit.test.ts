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
