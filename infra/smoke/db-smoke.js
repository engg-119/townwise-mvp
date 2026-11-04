/* global process, console, URL -- Node, run with --input-type=module inside the API image */
/* eslint-disable import-x/no-extraneous-dependencies -- resolved from the API image, whose workspace declares these */
// Real-cluster smoke test (infra/README.md, step 10). infra/scripts/db-smoke.sh runs it once, inside the
// virtual network, in the deployed API image (so with the kit code that is live) as an execution of its own
// job, caj-townwise-db-smoke, whose identity reads only mongodb-uri and cannot be used from the container.
// It works in a scratch database, townwise_smoke, which it drops at the end, and prints check names only.
// A bad URI or a failed connection prints only an error name and code: Node's own crash output would print
// the URI, password included.
//
// The sign-in edge cases rest on these store results: google.ts answers 409 google_email_conflict when
// updateEmail throws DuplicateError('email'), and resolves two concurrent first sign-ins by re-reading after
// one create throws DuplicateError. They need the kit's duplicate-key fix for DocumentDB.
import { createMongoAuthStores, DuplicateError } from '@ckeith26/auth';
import { connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { createLogger } from '@ckeith26/server-core';

function fail(stage, err) {
  const code = err !== null && typeof err === 'object' && 'code' in err ? ` (code ${String(err.code)})` : '';
  console.log(`db smoke test failed at ${stage}: ${err instanceof Error ? err.name : 'error'}${code}`);
  process.exit(1);
}

let url;
try {
  url = new URL(process.env.MONGODB_URI ?? '');
  if (url.protocol !== 'mongodb+srv:' && process.env.NODE_ENV !== 'test') throw new TypeError('not mongodb+srv');
} catch (err) {
  fail('parsing MONGODB_URI', err);
}
url.pathname = '/townwise_smoke';
const logger = createLogger({ LOG_LEVEL: 'silent' });
let mongo;
try {
  mongo = await connectMongo({
    config: { MONGODB_URI: url.toString(), NODE_ENV: process.env.NODE_ENV === 'test' ? 'test' : 'production' },
    logger,
  });
} catch (err) {
  fail('connecting', err);
}

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push([name, 'pass']);
  } catch (err) {
    results.push([name, `FAIL (${err instanceof Error ? err.name : 'error'})`]);
  }
}
function expectDuplicate(err, field) {
  if (!(err instanceof DuplicateError) || err.field !== field) throw new Error(`expected DuplicateError(${field})`);
}
async function rejects(promise, field) {
  try {
    await promise;
  } catch (err) {
    expectDuplicate(err, field);
    return;
  }
  throw new Error('expected a rejection');
}

try {
  await mongo.connection.dropDatabase();
  const { users } = createMongoAuthStores(mongo.connection);
  const now = new Date();

  await check('connect and build every auth index (unique, partial unique, TTL)', async () => {
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    const names = (await mongo.connection.collection('users').indexes()).map((index) => index.name);
    if (!names.includes('email_1') || !names.includes('googleSubject_1')) throw new Error('missing user indexes');
  });

  const ada = await users.create({ email: 'ada@smoke.invalid', googleSubject: 'smoke-sub-ada', now });
  const bea = await users.create({ email: 'bea@smoke.invalid', now });

  await check('duplicate email on create is DuplicateError(email)', () =>
    rejects(users.create({ email: 'ada@smoke.invalid', now }), 'email'));
  await check('taken Google subject on link is DuplicateError(googleSubject)', () =>
    rejects(users.linkGoogleSubject({ id: bea.id, subject: 'smoke-sub-ada' }), 'googleSubject'));
  await check('email conflict on update is DuplicateError(email) (the 409 path)', () =>
    rejects(users.updateEmail({ id: bea.id, from: 'bea@smoke.invalid', to: ada.email }), 'email'));
  await check('two concurrent first sign-ins create one user; the other gets DuplicateError', async () => {
    const outcomes = await Promise.allSettled([1, 2].map(() =>
      users.create({ email: 'cy@smoke.invalid', googleSubject: 'smoke-sub-cy', now })));
    const created = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    if (created.length !== 1 || rejected.length !== 1) throw new Error('expected one create and one rejection');
    if (!(rejected[0].reason instanceof DuplicateError)) throw new Error('the losing create was not a DuplicateError');
    if ((await users.findByGoogleSubject('smoke-sub-cy'))?.id !== created[0].value.id) throw new Error('re-read failed');
  });
} catch (err) {
  fail('setting up the checks', err);
} finally {
  try {
    await mongo.connection.dropDatabase();
    await mongo.close();
  } catch (err) {
    fail('cleaning up', err);
  }
}

for (const [name, outcome] of results) console.log(`${outcome}: ${name}`);
if (results.length !== 5 || results.some(([, outcome]) => outcome !== 'pass')) process.exit(1);
console.log('db smoke test passed');
