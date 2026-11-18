// The staff Overview's pure parts (handlers/overview.ts, openspec change staff-overview, design decisions 4 and 5): the
// action groups against every audit action.
import { describe, expect, it } from 'vitest';

import { ACTION_GROUP, ACTION_GROUPS } from '../src/handlers/overview.ts';
import { AUDIT_DETAIL_KEYS } from '../src/stores/audit-events.ts';

/** Design decision 4's table, row by row. */
const DESIGN_TABLE = {
  uploads: [
    'sales.uploaded', 'sales.deleted', 'sales.upload_deleted', 'data.turned_off', 'data.turned_on', 'data.renamed', 'data.edited',
    'file.uploaded', 'file.deleted', 'file.raw_deleted', 'files.raw_deleted_all', 'order.item_sales_uploaded', 'order.item_sales_deleted',
  ],
  notes: [
    'note.created', 'note.updated', 'note.deleted', 'rule.created', 'rule.updated', 'rule.deleted', 'owner_calendar.added',
    'owner_calendar.removed', 'owner_calendar.refreshed', 'google_calendar.connected', 'google_calendar.disconnected',
  ],
  townwiseAi: [
    'chat.turn_completed', 'chat.conversation_deleted', 'agent.question_answered', 'agent.suggestion_accepted', 'agent.suggestion_dismissed',
    'file.ai_read_requested', 'file.ai_undone', 'order.setup_read', 'order.card_saved', 'order.card_dismissed', 'calibration.requested',
  ],
  orders: ['order.setup_saved', 'order.count_saved', 'order.decision_saved', 'order.rule_saved', 'order.rule_turned_off'],
  team: [
    'member.invited', 'member.joined', 'member.role_changed', 'member.removed', 'member.left', 'location.created', 'location.updated',
    'location.deleted', 'org.renamed', 'org.weekly_suggestions_changed',
  ],
  none: [
    'access_request.created', 'access_request.approved', 'access_request.rejected', 'access_request.withdrawn', 'org.created',
    'org.suspended', 'org.reactivated', 'org.deleted', 'member.declined', 'file.ai_read', 'org.originals_deleted', 'forecast.imported',
    'forecast.published', 'forecast.withdrawn', 'forecast.deleted', 'calibration.finished', 'calibration.scheduled',
    'org.forecasts_switched', 'forecast_schedule.paused', 'forecast_schedule.resumed', 'view_as.started', 'view_as.ended',
    'open_as_admin.started', 'open_as_admin.ended', 'people.signed_out_everywhere', 'person.deleted', 'staff_action.not_applied',
  ],
} as const;

describe('the action groups', () => {
  it('place every audit action in exactly one group or in none, so a new action fails here until it is placed', () => {
    const actions = Object.keys(AUDIT_DETAIL_KEYS).sort();
    expect(Object.keys(ACTION_GROUP).sort()).toEqual(actions);
    // The design's rows hold each action once, and together hold every action.
    const rows = Object.values(DESIGN_TABLE).flat();
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual(actions);
  });

  it('match design decision 4’s table, row by row, in its group order', () => {
    expect(ACTION_GROUPS).toEqual(['uploads', 'notes', 'townwiseAi', 'orders', 'team']);
    for (const [group, actions] of Object.entries(DESIGN_TABLE)) {
      const placed = Object.entries(ACTION_GROUP).filter(([, each]) => (each ?? 'none') === group).map(([action]) => action).sort();
      expect({ group, placed }).toEqual({ group, placed: [...actions].sort() });
    }
  });
});
