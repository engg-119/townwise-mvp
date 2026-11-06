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
      'tw_access_requests', 'tw_audit_events', 'tw_chat_conversations', 'tw_chat_live_turns', 'tw_chat_usage', 'tw_files',
      'tw_imports', 'tw_locations', 'tw_members', 'tw_notes', 'tw_orgs', 'tw_sales_days', 'tw_upload_days', 'tw_uploads',
      'tw_view_as_grants',
    ]);
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
      'TwFile', 'TwImport', 'TwUploadDay',
    ]) {
      for (const [fields] of indexesOf(connection, model)) {
        const keys = Object.keys(fields);
        if (keys.length < 2) continue;
        if (model === 'TwMember' && keys[0] === 'userId') continue;
        // The sweeper's index spans organizations (stores/cross-tenant.ts); the reader's claim index is single-key.
        if (model === 'TwFile' && keys[0] === 'status') continue;
        if (model === 'TwImport' && keys[0] === 'status') continue;
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

  it('keeps one live tuning chat turn per person per organization', () => {
    expect(indexesOf(registered(), 'TwChatLiveTurn')).toContainEqual([
      { orgId: 1, userId: 1 }, expect.objectContaining({ unique: true }),
    ]);
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
    expect(connection.models.TwFile?.schema.get('strict')).toBe('throw');
    expect(indexesOf(connection, 'TwImport')).toContainEqual([
      { activeLocation: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { activeLocation: { $type: 'objectId' } } }),
    ]);
    expect(indexesOf(connection, 'TwUploadDay')).toContainEqual([{ orgId: 1, day: 1 }, expect.objectContaining({ unique: true })]);
  });
});
