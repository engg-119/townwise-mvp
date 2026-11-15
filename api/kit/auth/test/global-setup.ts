import { createRedis } from '@ckeith26/redis';
import { createLogger } from '@ckeith26/server-core';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { waitForRedis } from './helpers/redis-ready.ts';
import { MONGO_IMAGE, VALKEY_IMAGE } from './images.ts';

declare module 'vitest' {
  export interface ProvidedContext { mongoUri: string; redisUrl: string }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [mongo, valkey] = await Promise.all([
    // Docker's default soft limit of 1024 open files aborted mongod mid-run in coffee-chat (WiredTiger error 24).
    // mongo 8.0.32 exits on GitHub's kernel (6.19 and newer, fatal 12257600, SERVER-121912).
    // glibc.pthread.rseq=1 lets that build start; rseq=0 does not.
    new MongoDBContainer(MONGO_IMAGE)
      .withUlimits({ nofile: { soft: 64000, hard: 64000 } })
      .withEnvironment({ GLIBC_TUNABLES: 'glibc.pthread.rseq=1' })
      .start(),
    new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start(),
  ]);
  const redisUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`;
  // Once through the mapped port, as every test server connects. On 2026-11-14 the Townwise API suite's test Valkey,
  // on this harness, passed testcontainers' port check (a TCP connect) there, then refused or reset every client, and
  // 66 suites failed in turn. Now that each test server waits up to 15 s (helpers/redis-ready.ts), that would run into
  // the job's time limit, so the run fails here instead. CI turns Ryuk off, so stop the containers first.
  const probe = createRedis({
    config: { REDIS_URL: redisUrl, REDIS_KEY_PREFIX: 'auth-test:', NODE_ENV: 'test' },
    logger: createLogger({ LOG_LEVEL: 'silent' }),
  });
  try {
    await waitForRedis(probe);
  } catch (err) {
    // Not close(): it waits for the client's end event, which never comes while the client is between reconnects.
    probe.client.disconnect();
    await Promise.all([mongo.stop(), valkey.stop()]);
    throw new Error(`the test Valkey does not answer at ${redisUrl}`, { cause: err });
  }
  await probe.close();
  project.provide('mongoUri', mongo.getConnectionString());
  project.provide('redisUrl', redisUrl);
  // The tests run on a clock frozen at 2026-06-01 (helpers/server.ts), but mongod's TTL monitor deletes by the wall
  // clock, by which every session and magic link a test writes has long expired. Its pass, once a minute, would delete
  // them mid-test. Nothing here may expire by the wall clock (mongo-stores.int.test.ts pins this).
  const ttl = await mongo.exec(['mongosh', '--quiet', '--eval', 'db.adminCommand({ setParameter: 1, ttlMonitorEnabled: false })']);
  if (ttl.exitCode !== 0) throw new Error(`could not turn off the TTL monitor: ${ttl.output}`);
  return async () => { await Promise.all([mongo.stop(), valkey.stop()]); };
}
