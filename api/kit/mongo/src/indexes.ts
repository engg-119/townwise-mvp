import type { Connection } from 'mongoose';

import { ConfigError, type Logger } from '@ckeith26/server-core';

import { buildAtBoot as defaultBuildAtBoot } from './buildAtBoot.ts';

declare module 'mongoose' {
  interface IndexManager {
    /** Runtime accepts the missing list. The published type only has driver create options. */
    createIndexes(options?: {
      toCreate?: readonly (readonly [Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>])[];
    }): Promise<void>;
  }
}

export interface PendingIndex {
  readonly model: string;
  readonly collection: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly options: Readonly<{
    name?: string;
    unique?: boolean;
    expireAfterSeconds?: number;
    sparse?: boolean;
    partialFilterExpression?: object;
  }>;
  readonly estimatedDocuments: number;
}

export class IndexError extends Error {
  override readonly name = 'IndexError';
}

/** MongoDB's default name, unless the schema set one. `email_1`, `$**_1`. */
export function indexName(fields: Readonly<Record<string, unknown>>, options: Readonly<{ name?: string }>): string {
  if (options.name !== undefined) return options.name;
  return Object.entries(fields).map(([field, value]) => `${field}_${String(value)}`).join('_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** `unique: true`, or mongoose's `[true, message]` form. Both are a unique index. */
function isUnique(unique: unknown): boolean {
  return unique === true || (Array.isArray(unique) && unique[0] === true);
}

function pendingOptions(options: Record<string, unknown>): PendingIndex['options'] {
  const pending: {
    name?: string;
    unique?: boolean;
    expireAfterSeconds?: number;
    sparse?: boolean;
    partialFilterExpression?: object;
  } = {};
  if (typeof options.name === 'string') pending.name = options.name;
  if (isUnique(options.unique)) pending.unique = true;
  else if (options.unique === false) pending.unique = false;
  if (typeof options.expireAfterSeconds === 'number') pending.expireAfterSeconds = options.expireAfterSeconds;
  if (typeof options.sparse === 'boolean') pending.sparse = options.sparse;
  if (isRecord(options.partialFilterExpression)) pending.partialFilterExpression = options.partialFilterExpression;
  return pending;
}

function isRequired(options: Record<string, unknown>): boolean {
  return isUnique(options.unique) || typeof options.expireAfterSeconds === 'number';
}

function readPair(value: unknown): { fields: Record<string, unknown>; options: Record<string, unknown> } {
  if (!isUnknownList(value) || value.length < 2) {
    throw new IndexError('diffIndexes returned an index spec this module does not understand');
  }
  const fields = value[0];
  const options = value[1];
  if (!isRecord(fields) || !isRecord(options)) {
    throw new IndexError('diffIndexes returned an index spec this module does not understand');
  }
  return { fields, options };
}

function isMissingNamespace(err: unknown): boolean {
  if (!isRecord(err)) return false;
  if (err.codeName === 'NamespaceNotFound' || err.code === 26) return true;
  return isMissingNamespace(err.cause);
}

async function countDocuments(model: { estimatedDocumentCount(): Promise<number> }): Promise<number> {
  try {
    return await model.estimatedDocumentCount();
  } catch (err) {
    // A model registered before its first write has no collection yet. That is zero documents.
    if (isMissingNamespace(err)) return 0;
    throw err;
  }
}

/**
 * Builds missing schema indexes one at a time, never drops, then refuses a model
 * registered after this call. A unique or TTL index that is missing or fails to
 * build throws IndexError.
 */
export async function ensureIndexes(
  connection: Connection,
  deps: { logger: Logger; buildAtBoot?: (index: PendingIndex) => boolean },
): Promise<void> {
  const decide = deps.buildAtBoot ?? defaultBuildAtBoot;
  for (const model of Object.values(connection.models)) {
    const diffResult: unknown = await model.diffIndexes({ indexOptionsToCreate: true });
    if (!isRecord(diffResult) || !isUnknownList(diffResult.toDrop) || !isUnknownList(diffResult.toCreate)) {
      throw new IndexError(`${model.modelName} diffIndexes returned an unexpected result`);
    }
    for (const dropName of diffResult.toDrop) {
      if (typeof dropName !== 'string') {
        throw new IndexError(`${model.modelName} has an undeclared index whose name is not a string`);
      }
      deps.logger.warn({ model: model.modelName, index: dropName }, 'mongo.index_undeclared');
    }
    if (diffResult.toCreate.length === 0) continue;

    const estimatedDocuments = await countDocuments(model);
    for (const entry of diffResult.toCreate) {
      const { fields, options } = readPair(entry);
      const name = indexName(fields, pendingOptions(options));
      const pending: PendingIndex = {
        model: model.modelName,
        collection: model.collection.collectionName,
        fields,
        options: pendingOptions(options),
        estimatedDocuments,
      };
      const required = isRequired(options);
      if (!decide(pending)) {
        if (required) {
          throw new IndexError(`${model.modelName}.${name} is missing and buildAtBoot declined it; run the one-off index build`);
        }
        deps.logger.warn({ model: model.modelName, index: name }, 'mongo.index_declined');
        continue;
      }

      const started = Date.now();
      deps.logger.info({ model: model.modelName, index: name }, 'mongo.index_build_started');
      // createIndexes emits 'error' and also rejects. Without a listener the emit throws.
      const ignoreModelError = (err: unknown): void => {
        if (err === undefined) return;
      };
      model.on('error', ignoreModelError);
      try {
        await model.createIndexes({ toCreate: [[fields, options]] });
        deps.logger.info(
          { model: model.modelName, index: name, durationMs: Date.now() - started },
          'mongo.index_built',
        );
      } catch (err) {
        if (required) {
          deps.logger.error({ model: model.modelName, index: name, err }, 'mongo.index_build_failed');
          throw new IndexError(`${model.modelName}.${name} failed to build; see the mongo.index_build_failed log line`);
        }
        deps.logger.warn({ model: model.modelName, index: name, err }, 'mongo.index_build_failed');
      } finally {
        model.removeListener('error', ignoreModelError);
      }
    }
  }

  connection.on('model', () => {
    throw new ConfigError([{
      variable: 'models',
      problem: 'a model was registered after ensureIndexes; register every store before calling it',
    }]);
  });
}
