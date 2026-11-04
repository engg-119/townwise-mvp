import mongoose from 'mongoose';
import { expect, it } from 'vitest';

import { documentDbIndexProblems } from '../src/documentDb.ts';

function add(
  connection: mongoose.Connection,
  name: string,
  fields: mongoose.IndexDefinition,
  options?: mongoose.IndexOptions,
): void {
  const schema = new mongoose.Schema({
    a: mongoose.Schema.Types.Mixed,
    b: mongoose.Schema.Types.Mixed,
    loc: mongoose.Schema.Types.Mixed,
    body: String,
  });
  schema.index(fields, options);
  connection.model(name, schema);
}

function registerPassing(connection: mongoose.Connection): void {
  add(connection, 'Compound', { a: 1, b: -1 });
  add(connection, 'Unique', { a: 1 }, { unique: true });
  add(connection, 'Ttl', { a: 1 }, { expireAfterSeconds: 60 });
  add(connection, 'Text', { body: 'text' });
  add(connection, 'Geo', { loc: '2dsphere' });
}

it('documentDbIndexProblems: flags hashed, 2d, wildcard, collation, hidden, sparse plus partial, and $or nested inside $and in a partial filter; passes compound, unique, TTL, text and 2dsphere', () => {
  const flagged = ['Hashed', 'TwoD', 'Wildcard', 'Collation', 'Hidden', 'SparsePartial', 'NestedOr'];
  const passing = ['Compound', 'Unique', 'Ttl', 'Text', 'Geo'];
  const connection = mongoose.createConnection();
  add(connection, 'Hashed', { a: 'hashed' });
  add(connection, 'TwoD', { loc: '2d' });
  add(connection, 'Wildcard', { '$**': 1 });
  add(connection, 'Collation', { a: 1 }, { collation: { locale: 'en' } });
  add(connection, 'Hidden', { a: 1 }, { hidden: true });
  add(connection, 'SparsePartial', { a: 1 }, {
    sparse: true,
    partialFilterExpression: { a: { $gt: 1 } },
  });
  add(connection, 'NestedOr', { a: 1 }, {
    partialFilterExpression: { $and: [{ $or: [{ a: 1 }, { b: 1 }] }] },
  });
  registerPassing(connection);

  const problems = documentDbIndexProblems(connection);
  expect(problems).toHaveLength(7);
  for (const name of flagged) {
    expect(problems.filter((problem) => problem.startsWith(`${name}.`))).toHaveLength(1);
  }
  for (const name of passing) {
    expect(problems.join('\n')).not.toContain(name);
  }

  const clean = mongoose.createConnection();
  registerPassing(clean);
  expect(documentDbIndexProblems(clean)).toEqual([]);
});
