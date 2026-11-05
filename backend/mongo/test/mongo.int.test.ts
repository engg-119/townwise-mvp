import mongoose, { Schema, trusted } from 'mongoose';
import { beforeEach, expect, it } from 'vitest';

import { ConfigError, type Logger } from '@ckeith26/server-core';

import { connectMongo, ensureIndexes, isDuplicateKeyError, type Mongo } from '../src/index.ts';
import { captureLogs } from './helpers/logs.ts';
import { resetDatabase, testUri } from './helpers/mongo.ts';

interface Opened {
  mongo: Mongo;
  logger: Logger;
  lines: string[];
}

function tcpCount(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap').length;
}

function logRecord(line: string): { msg?: string; index?: string } {
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) return {};
  const record: { msg?: string; index?: string } = {};
  if ('msg' in value && typeof value.msg === 'string') record.msg = value.msg;
  if ('index' in value && typeof value.index === 'string') record.index = value.index;
  return record;
}

async function openKit(): Promise<Opened> {
  const captured = captureLogs();
  const mongo = await connectMongo({
    config: { MONGODB_URI: testUri(), NODE_ENV: 'test' },
    logger: captured.logger,
  });
  return { mongo, logger: captured.logger, lines: captured.lines };
}

async function withKit(run: (opened: Opened) => Promise<void>): Promise<void> {
  const opened = await openKit();
  try {
    await run(opened);
  } finally {
    await opened.mongo.close();
  }
}

beforeEach(async () => {
  await resetDatabase();
});

it('sanitizeFilter: {email: {$ne: null}} throws CastError; trusted({$gt: 0}) works; another connection is unaffected', async () => {
  await withKit(async ({ mongo }) => {
    const schema = new Schema({ email: String, n: Number }, { collection: 'people', autoIndex: false });
    const Model = mongo.connection.model('Person', schema);
    await Model.create({ email: 'ada@example.com', n: 1 });
    await expect(Model.findOne({ email: { $ne: null } })).rejects.toMatchObject({ name: 'CastError' });
    const trustedDocs = await Model.find({ n: trusted({ $gt: 0 }) });
    expect(trustedDocs).toHaveLength(1);
    expect(trustedDocs[0]?.email).toBe('ada@example.com');

    const plain = mongoose.createConnection(testUri(), { serverSelectionTimeoutMS: 5000, autoIndex: false });
    try {
      await plain.asPromise();
      const found = await plain.model('Person', schema).findOne({ email: { $ne: null } });
      expect(found?.email).toBe('ada@example.com');
    } finally {
      await plain.close();
    }
  });
});

it('sanitizeFilter regression guard: passing sanitizeFilter only in createConnection options does NOT enable it', async () => {
  const plain = mongoose.createConnection(testUri(), {
    sanitizeFilter: true,
    serverSelectionTimeoutMS: 5000,
    autoIndex: false,
  });
  try {
    await plain.asPromise();
    const Model = plain.model('Guard', new Schema({ email: String }, { collection: 'guards', autoIndex: false }));
    await Model.create({ email: 'ada@example.com' });
    const found = await Model.findOne({ email: { $ne: null } });
    expect(found?.email).toBe('ada@example.com');
  } finally {
    await plain.close();
  }
});

it('sanitizeFilter limit: an array filter value is cast to $in and matches', async () => {
  await withKit(async ({ mongo }) => {
    const Model = mongo.connection.model('Code', new Schema(
      { code: String },
      { collection: 'codes', autoIndex: false },
    ));
    await Model.create({ code: '000002' });
    const found = await Model.findOne({ code: ['000001', '000002'] });
    expect(found?.code).toBe('000002');
  });
});

it('connectMongo rejects within 6s for an unreachable host, and neither the error nor any log line contains the password', async () => {
  const password = ['pw', String(process.pid), 'gone'].join('-');
  const captured = captureLogs();
  const started = Date.now();
  let thrown: unknown;
  try {
    await connectMongo({
      config: {
        MONGODB_URI: `mongodb://kit:${password}@127.0.0.1:9/kit_test?directConnection=true`,
        NODE_ENV: 'test',
      },
      logger: captured.logger,
    });
  } catch (err) {
    thrown = err;
  }
  expect(Date.now() - started).toBeLessThan(6000);
  expect(thrown).toBeInstanceOf(Error);
  const rendered = `${String(thrown)}\n${JSON.stringify(thrown)}`;
  expect(rendered).not.toContain(password);
  for (const line of captured.lines) expect(line).not.toContain(password);
});

it('connectMongo with a wrong password: no log line contains the password', async () => {
  const created = ['pw', String(process.pid), 'created'].join('-');
  const wrong = ['pw', String(process.pid), 'wrong'].join('-');
  const plain = mongoose.createConnection(testUri(), { serverSelectionTimeoutMS: 5000 });
  let opened: Mongo | undefined;
  const captured = captureLogs();
  let thrown: unknown;
  try {
    await plain.asPromise();
    const db = plain.db;
    if (db === undefined) throw new Error('mongo database handle missing');
    await db.command({ createUser: 'kit', pwd: created, roles: [] });
    try {
      opened = await connectMongo({
        config: { MONGODB_URI: testUri({ password: wrong }), NODE_ENV: 'test' },
        logger: captured.logger,
      });
    } catch (err) {
      thrown = err;
    }
  } finally {
    await opened?.close();
    try {
      await plain.db?.command({ dropUser: 'kit' });
    } catch {
      // createUser did not leave a user behind.
    }
    await plain.close();
  }
  expect(opened).toBeUndefined();
  expect(thrown).toBeInstanceOf(Error);
  const rendered = [String(thrown), ...captured.lines].join('\n');
  expect(rendered).not.toContain(created);
  expect(rendered).not.toContain(wrong);
});

it('close() resolves and leaves no open handles', async () => {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const baseline = tcpCount();
  const mongo = await connectMongo({
    config: { MONGODB_URI: testUri(), NODE_ENV: 'test' },
    logger: captureLogs().logger,
  });
  await mongo.close();
  const deadline = Date.now() + 1000;
  let count = tcpCount();
  while (count !== baseline && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    count = tcpCount();
  }
  expect(count).toBe(baseline);
  expect(mongo.connection.readyState).toBe(0);
});

it('ensureIndexes builds a declared unique index before the first write, and a duplicate insert gives isDuplicateKeyError', async () => {
  await withKit(async ({ mongo, logger }) => {
    const schema = new Schema({ email: String }, { collection: 'accounts', autoIndex: false });
    schema.index({ email: 1 }, { unique: true });
    const Model = mongo.connection.model('Account', schema);
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    const indexes = await Model.collection.indexes();
    expect(indexes.some((index) => index.name === 'email_1' && index.unique === true)).toBe(true);
    await Model.create({ email: 'one@example.com' });
    let thrown: unknown;
    try {
      await Model.create({ email: 'one@example.com' });
    } catch (err) {
      thrown = err;
    }
    expect(isDuplicateKeyError(thrown)).toBe(true);
  });
});

it('ensureIndexes fails boot when a unique index cannot build over duplicates', async () => {
  await withKit(async ({ mongo, logger, lines }) => {
    const email = `dup-${String(process.pid)}-${String(Date.now())}@example.net`;
    await mongo.connection.collection('accounts').insertMany([{ email }, { email }]);
    const schema = new Schema({ email: String }, { collection: 'accounts', autoIndex: false });
    schema.index({ email: 1 }, { unique: true });
    mongo.connection.model('Account', schema);
    let thrown: unknown;
    try {
      await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ name: 'IndexError' });
    const rendered = [String(thrown), ...lines].join('\n');
    expect(rendered).not.toContain(email);
  });
});

it('ensureIndexes fails boot when buildAtBoot declines a TTL index, and only warns when it declines a plain index', async () => {
  await withKit(async ({ mongo, logger }) => {
    const schema = new Schema({ at: Date }, { collection: 'ttl_docs', autoIndex: false });
    schema.index({ at: 1 }, { expireAfterSeconds: 60 });
    mongo.connection.model('TtlDoc', schema);
    let thrown: unknown;
    try {
      await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ name: 'IndexError' });
    if (!(thrown instanceof Error)) throw new Error('expected IndexError');
    expect(thrown.message).toMatch(/is missing and buildAtBoot declined it; run the one-off index build/);
  });

  await withKit(async ({ mongo, logger, lines }) => {
    const schema = new Schema({ a: Number }, { collection: 'plain_docs', autoIndex: false });
    schema.index({ a: 1 });
    mongo.connection.model('PlainDoc', schema);
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => false });
    expect(lines.map(logRecord).some((record) => record.msg === 'mongo.index_declined')).toBe(true);
  });
});

it('ensureIndexes warns about, and does not drop, an index the schema does not declare', async () => {
  await withKit(async ({ mongo, logger, lines }) => {
    await mongo.connection.collection('legacies').createIndex({ legacy: 1 });
    const Model = mongo.connection.model('Legacy', new Schema(
      { name: String },
      { collection: 'legacies', autoIndex: false },
    ));
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    const undeclared = lines.map(logRecord).filter((record) => record.msg === 'mongo.index_undeclared' && record.index === 'legacy_1');
    expect(undeclared).toHaveLength(1);
    const indexes = await Model.collection.indexes();
    expect(indexes.some((index) => index.name === 'legacy_1')).toBe(true);
  });
});

it('a model registered after ensureIndexes throws', async () => {
  await withKit(async ({ mongo, logger }) => {
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    expect(() => {
      mongo.connection.model('Late', new Schema({ a: String }));
    }).toThrow(ConfigError);
  });
});

it('buildAtBoot default: builds every missing index, including unique, TTL and plain', async () => {
  await withKit(async ({ mongo, logger }) => {
    const schema = new Schema(
      { email: String, at: Date, a: Number },
      { collection: 'boot', autoIndex: false },
    );
    schema.index({ email: 1 }, { unique: true });
    schema.index({ at: 1 }, { expireAfterSeconds: 60 });
    schema.index({ a: 1 });
    const Model = mongo.connection.model('Boot', schema);
    await Model.create({ email: 'one@example.com', at: new Date(), a: 1 });
    await ensureIndexes(mongo.connection, { logger });
    const indexes = await Model.collection.indexes();
    expect(indexes.some((index) => index.name === 'email_1' && index.unique === true)).toBe(true);
    expect(indexes.some((index) => index.name === 'at_1' && index.expireAfterSeconds === 60)).toBe(true);
    expect(indexes.some((index) => index.name === 'a_1')).toBe(true);
  });
});
