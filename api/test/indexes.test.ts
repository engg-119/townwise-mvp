import { documentDbIndexProblems } from '@ckeith26/mongo';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { createTownwiseStores } from '../src/stores/index.ts';

function registered(): mongoose.Connection {
  const connection = mongoose.createConnection();
  createTownwiseStores(connection);
  return connection;
}

function indexesOf(connection: mongoose.Connection, model: string): [Record<string, unknown>, Record<string, unknown>][] {
  const found = connection.models[model];
  if (found === undefined) throw new Error(`${model} is not registered`);
  return found.schema.indexes();
}

describe('indexes', () => {
  it('registers the Townwise models on their tw_ collections', () => {
    const connection = registered();
    const collections = Object.values(connection.models).map((model) => model.collection.collectionName).sort();
    expect(collections).toEqual([
      'tw_access_requests',
      // U9, TownwiseAI's questions, and its weekly suggestions with their pass rows.
      'tw_agent_answers', 'tw_agent_suggestions', 'tw_suggestion_passes',
      'tw_audit_events', 'tw_chat_conversations', 'tw_chat_live_turns', 'tw_chat_proposals', 'tw_chat_usage',
      // A TownwiseAI turn's progress (openspec change resumable-chat-turns).
      'tw_chat_turns',
      'tw_file_entries', 'tw_file_sweeps', 'tw_files', 'tw_files_usage', 'tw_imports', 'tw_locations', 'tw_members', 'tw_notes', 'tw_orgs', 'tw_sales_days', 'tw_upload_days',
      'tw_uploads', 'tw_view_as_grants',
      // U11, statement moments.
      'tw_welcomes',
      // The display name for TownwiseAI's greeting (account-level).
      'tw_profiles',
      // U13B, forecast runs.
      'tw_forecast_runs', 'tw_forecasts',
      // The forecast lab.
      'tw_calibrations',
      // D42, the weekly refresh.
      'tw_forecast_weeks', 'tw_forecast_schedule',
      'tw_order_cards', 'tw_order_decisions', 'tw_order_rules',
      'tw_order_setups', 'tw_item_sales', 'tw_order_counts',
      // Business rules (spec 6.24).
      'tw_business_rules',
      // The owner's own calendars.
      'tw_calendar_sources', 'tw_calendar_events',
      // Google access for calendars (openspec change connect-google-calendar).
      'tw_google_connections',
      // The days each person used the app (openspec change staff-overview).
      'tw_activity_days',
    ].sort());
  });

  it('reads active days by organization and day, by day across organizations, and by person (staff-overview)', () => {
    const connection = registered();
    const keys = indexesOf(connection, 'TwActivityDay').map(([fields]) => fields);
    expect(keys).toEqual([{ orgId: 1, day: 1 }, { day: 1 }, { userId: 1 }]);
    expect(connection.models.TwActivityDay?.schema.get('strict')).toBe('throw');
    expect(connection.models.TwActivityDay?.schema.get('versionKey')).toBe(false);
  });

  it('keeps one weekly refresh row per location per week (D42)', () => {
    expect(indexesOf(registered(), 'TwForecastWeek')).toContainEqual([{ orgId: 1, locationId: 1, week: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('keeps one weekly suggestions pass per location per week', () => {
    expect(indexesOf(registered(), 'TwSuggestionPass')).toContainEqual([{ orgId: 1, locationId: 1, week: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('declares only indexes DocumentDB 5.0 builds', () => {
    expect(documentDbIndexProblems(registered())).toEqual([]);
  });

  it('enforces one open invitation per address per organization, and one active organization per person', () => {
    const members = indexesOf(registered(), 'TwMember');
    expect(members).toContainEqual([
      { orgId: 1, inviteEmail: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { inviteEmail: { $type: 'string' } } }),
    ]);
    expect(members).toContainEqual([
      { activeUserId: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { activeUserId: { $type: 'string' } } }),
    ]);
  });

  it('enforces one pending request per person, unique location names per organization and one live grant per session', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwAccessRequest')).toContainEqual([
      { userId: 1 }, expect.objectContaining({ unique: true, partialFilterExpression: { status: 'pending' } }),
    ]);
    expect(indexesOf(connection, 'TwLocation')).toContainEqual([
      { orgId: 1, nameKey: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(indexesOf(connection, 'TwViewAsGrant')).toContainEqual([
      { activeSessionId: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { activeSessionId: { $type: 'string' } } }),
    ]);
  });

  it('leads every tenant compound index with orgId, except the two seat indexes keyed by the person and the files sweep', () => {
    const connection = registered();
    for (const model of [
      'TwMember', 'TwLocation', 'TwSalesDay', 'TwUpload', 'TwNote', 'TwChatConversation', 'TwChatLiveTurn', 'TwChatUsage',
      'TwChatProposal', 'TwFile', 'TwImport', 'TwUploadDay', 'TwWelcome',
      // U13B.
      'TwForecastRun', 'TwForecast', 'TwCalibration',
      'TwOrderCard', 'TwOrderDecision', 'TwOrderRule', 'TwOrderSetup', 'TwItemSalesDay', 'TwOrderCount',
      'TwBusinessRule',
      // The owner's own calendars, and Google access for them.
      'TwCalendarSource', 'TwCalendarEvent', 'TwGoogleConnection',
      // Active days (staff-overview).
      'TwActivityDay',
    ]) {
      for (const [fields] of indexesOf(connection, model)) {
        const keys = Object.keys(fields);
        if (keys.length < 2) continue;
        if (model === 'TwMember' && keys[0] === 'userId') continue;
        // The sweeper's index spans organizations (stores/cross-tenant.ts); the reader's claim index is single-key.
        if (model === 'TwFile' && keys[0] === 'status') continue;
        // The TownwiseAI reader's claim (spec 11A.9) spans organizations too: the oldest read asked for, in any.
        if (model === 'TwFile' && keys[0] === 'ai.status') continue;
        if (model === 'TwImport' && keys[0] === 'status') continue;
        // The lab callback finds a calibration by its id and token hash, before any organization is known.
        if (model === 'TwCalibration' && keys[0] === '_id') continue;
        expect(keys[0]).toBe('orgId');
      }
    }
  });

  it('lists a person’s conversations per location newest first, and keeps one chat cost document per organization per month', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwChatConversation')).toContainEqual([
      { orgId: 1, locationId: 1, userId: 1, updatedAt: -1 }, expect.anything(),
    ]);
    expect(indexesOf(connection, 'TwChatUsage')).toContainEqual([
      { orgId: 1, month: 1 }, expect.objectContaining({ unique: true }),
    ]);
  });

  it('keeps one record per TownwiseAI proposal per conversation, and finds a location’s for its deletion', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwChatProposal')).toContainEqual([
      { orgId: 1, conversationId: 1, proposalId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(indexesOf(connection, 'TwChatProposal')).toContainEqual([{ orgId: 1, locationId: 1 }, expect.anything()]);
  });

  // U9, TownwiseAI's questions.
  it('keeps one answer per TownwiseAI question per location', () => {
    expect(indexesOf(registered(), 'TwAgentAnswer')).toContainEqual([
      { orgId: 1, locationId: 1, questionId: 1 }, expect.objectContaining({ unique: true }),
    ]);
  });

  it('keeps one live tuning chat turn per person per organization', () => {
    expect(indexesOf(registered(), 'TwChatLiveTurn')).toContainEqual([
      { orgId: 1, userId: 1 }, expect.objectContaining({ unique: true }),
    ]);
  });

  it('keeps one record per TownwiseAI turn, and indexes the sweep’s and the deletions’ queries (resumable-chat-turns)', () => {
    const turns = indexesOf(registered(), 'TwChatTurn');
    expect(turns).toContainEqual([{ orgId: 1, turnId: 1 }, expect.objectContaining({ unique: true })]);
    for (const keys of [{ orgId: 1, conversationId: 1 }, { orgId: 1, locationId: 1 }, { userId: 1 }, { state: 1, leaseUntil: 1 }, { endedAt: 1 }]) {
      expect(turns.map(([fields]) => fields)).toContainEqual(keys);
    }
  });

  // U11, statement moments.
  it('keeps one welcome marker per person per organization', () => {
    expect(indexesOf(registered(), 'TwWelcome')).toContainEqual([
      { orgId: 1, userId: 1 }, expect.objectContaining({ unique: true }),
    ]);
  });

  it('tw_business_rules has the unique orgId, locationId, key index', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwBusinessRule')).toContainEqual([
      { orgId: 1, locationId: 1, key: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(connection.models.TwBusinessRule?.schema.get('strict')).toBe(true);
  });

  it('keeps one profile per person', () => {
    expect(indexesOf(registered(), 'TwProfile')).toContainEqual([{ userId: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('keeps one sales row per location per day, and stores sales rows with strict: throw', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwSalesDay')).toContainEqual([
      { orgId: 1, locationId: 1, date: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(connection.models.TwSalesDay?.schema.get('strict')).toBe('throw');
  });

  it('stores files with a fingerprint per location, one active import per location, and one byte counter per organization per day', () => {
    const connection = registered();
    const files = indexesOf(connection, 'TwFile');
    expect(files).toContainEqual([{ orgId: 1, locationId: 1, uploadedAt: -1 }, expect.anything()]);
    expect(files).toContainEqual([{ orgId: 1, importId: 1, uploadedAt: 1 }, expect.anything()]);
    expect(files).toContainEqual([{ orgId: 1, locationId: 1, fingerprint: 1 }, expect.anything()]);
    expect(files).toContainEqual([{ status: 1, 'upload.expiresAt': 1 }, expect.anything()]);
    expect(files).toContainEqual([{ status: 1, uploadedAt: 1 }, expect.anything()]);
    expect(files).toContainEqual([{ purgeRaw: 1 }, expect.objectContaining({ sparse: true })]);
    expect(connection.models.TwFile?.schema.get('strict')).toBe('throw');
    expect(indexesOf(connection, 'TwImport')).toContainEqual([
      { activeLocation: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { activeLocation: { $type: 'objectId' } } }),
    ]);
    expect(indexesOf(connection, 'TwUploadDay')).toContainEqual([{ orgId: 1, day: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('keeps the file reader’s AI spend apart from the chat’s, one counter per organization per month', () => {
    expect(indexesOf(registered(), 'TwFilesUsage')).toContainEqual([{ orgId: 1, month: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('holds a location’s calendars in 5 unique slots, finds due links for the refresh loop, and reads a calendar’s events by generation and date', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwCalendarSource')).toContainEqual([
      { orgId: 1, locationId: 1, slot: 1 }, expect.objectContaining({ unique: true }),
    ]);
    // The refresh loop's claim spans organizations (stores/cross-tenant.ts claimDueCalendar).
    expect(indexesOf(connection, 'TwCalendarSource')).toContainEqual([{ nextRefreshAt: 1 }, expect.anything()]);
    expect(connection.models.TwCalendarSource?.schema.path('slot')).toMatchObject({ options: { min: 0, max: 4 } });
    expect(indexesOf(connection, 'TwCalendarEvent')).toContainEqual([{ orgId: 1, sourceId: 1, generation: 1, startDate: 1 }, expect.anything()]);
    for (const model of ['TwCalendarSource', 'TwCalendarEvent']) expect(connection.models[model]?.schema.get('strict')).toBe('throw');
  });

  it('keeps one ordering setup per location, and one item sales day and one count per location per date, strict: throw', () => {
    const connection = registered();
    expect(indexesOf(connection, 'TwOrderSetup')).toContainEqual([{ orgId: 1, locationId: 1 }, expect.objectContaining({ unique: true })]);
    for (const model of ['TwItemSalesDay', 'TwOrderCount']) {
      expect(indexesOf(connection, model)).toContainEqual([{ orgId: 1, locationId: 1, date: 1 }, expect.objectContaining({ unique: true })]);
    }
    for (const model of ['TwOrderSetup', 'TwItemSalesDay', 'TwOrderCount']) expect(connection.models[model]?.schema.get('strict')).toBe('throw');
    expect(indexesOf(connection, 'TwOrderCard')).toContainEqual([
      { orgId: 1, conversationId: 1, proposalId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(indexesOf(connection, 'TwOrderCard').map(([keys]) => keys)).toContainEqual({ orgId: 1, locationId: 1 });
    // A9: the board reads its deliveries' edits, and a rule an item's latest edit, without scanning a location's edits.
    const decisions = indexesOf(connection, 'TwOrderDecision').map(([keys]) => keys);
    expect(decisions).toContainEqual({ orgId: 1, locationId: 1, delivery: 1 });
    expect(decisions).toContainEqual({ orgId: 1, locationId: 1, itemId: 1, createdAt: -1 });
  });

  it('lists a ZIP’s entries once each, in archive order', () => {
    const connection = registered();
    const entries = indexesOf(connection, 'TwFileEntry');
    expect(entries).toContainEqual([{ orgId: 1, fileId: 1, index: 1 }, expect.objectContaining({ unique: true })]);
    expect(entries).toContainEqual([{ orgId: 1, locationId: 1 }, expect.anything()]);
    expect(connection.models.TwFileEntry?.schema.get('strict')).toBe('throw');
  });
});
