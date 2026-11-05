import type { Connection, IndexDefinition, IndexOptions } from 'mongoose';

import { indexName } from './indexes.ts';

/** Index key values DocumentDB 5.0 cannot build. */
const UNSUPPORTED_KEY_TYPES = new Set(['hashed', '2d']);

/** Operators DocumentDB rejects inside a partialFilterExpression, at any depth. */
const UNSUPPORTED_PARTIAL_OPERATORS = ['$all', '$mod', '$or', '$xor', '$not', '$nor'];

function operatorsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) operatorsIn(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith('$')) found.push(key);
      operatorsIn(nested, found);
    }
  }
  return found;
}

function asFields(fields: IndexDefinition): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) copy[key] = value;
  return copy;
}

/** Why DocumentDB 5.0 would refuse this index, or null when it would build. */
function rejectionReason(fields: IndexDefinition, options: IndexOptions): string | null {
  for (const [field, value] of Object.entries(fields)) {
    if (field.includes('$**')) return 'wildcard indexes are not supported on any DocumentDB version';
    if (typeof value === 'string' && UNSUPPORTED_KEY_TYPES.has(value)) {
      return `${value} indexes are not supported on any DocumentDB version`;
    }
  }

  if (options.collation !== undefined) {
    return 'case-insensitive (collation) indexes need DocumentDB 8.0; production is 5.0';
  }
  if (options.hidden === true) return 'hidden indexes need DocumentDB 8.0.1; production is 5.0';

  if (options.partialFilterExpression !== undefined) {
    if (options.sparse === true) return 'sparse and partialFilterExpression cannot be combined';
    const used = operatorsIn(options.partialFilterExpression)
      .filter((op) => UNSUPPORTED_PARTIAL_OPERATORS.includes(op));
    if (used.length > 0) {
      return `partialFilterExpression cannot use ${[...new Set(used)].join(', ')}`;
    }
  }

  return null;
}

/** Schema-only. Empty means DocumentDB 5.0 would accept every declared index. */
export function documentDbIndexProblems(connection: Connection): string[] {
  const problems: string[] = [];
  for (const model of Object.values(connection.models)) {
    for (const [fields, options] of model.schema.indexes()) {
      const reason = rejectionReason(fields, options);
      if (reason === null) continue;
      problems.push(`${model.modelName}.${indexName(asFields(fields), options)}: ${reason}`);
    }
  }
  return problems;
}
