import { createRedis } from '@ckeith26/redis';
import { createLogger } from '@ckeith26/server-core';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { MONGO_IMAGE, VALKEY_IMAGE } from './images.ts';
import { waitForRedis } from './redis-ready.ts';

declare module 'vitest' {
  export interface ProvidedContext { mongoUri: string; redisUrl: string }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [mongo, valkey] = await Promise.all([
    // The kit's settings (api/kit/auth/test/global-setup.ts): a raised open-file limit, and rseq=1 so
    // mongo 8.0.32 starts on newer kernels. The data lives in memory (tmpfs): with four workers, each dropping its database
    // and rebuilding every index at each server start, a file took about 3 times longer than alone (11 s to 34 s on
    // average, 2026-11-19, PR #131's CI on camo), and the likeliest shared bottleneck is the one mongod's journal on disk.
    // Nothing here needs to survive the run. No key file is used (no username), so nothing copied into /data/db is hidden.
    new MongoDBContainer(MONGO_IMAGE)
      .withUlimits({ nofile: { soft: 64000, hard: 64000 } })
      .withEnvironment({ GLIBC_TUNABLES: 'glibc.pthread.rseq=1' })
      .withTmpFs({ '/data/db': 'rw,size=2g' })
      .start(),
    new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start(),
  ]);
  const redisUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`;
  // Once through the mapped port, as every test server connects. On 2026-11-14 the laptop runner's test Valkey passed
  // testcontainers' port check (a TCP connect) there, then refused or reset every client, and 66 suites failed in turn.
  // Now that each test server waits up to 15 s (helpers/redis-ready.ts), that would run into the job's time limit, so
  // the run fails here instead. CI turns Ryuk off, so stop the containers first.
  const probe = createRedis({
    config: { REDIS_URL: redisUrl, REDIS_KEY_PREFIX: 'townwise-test:', NODE_ENV: 'test' },
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
  // clock, by which every session and magic link a test writes has long expired. Its pass, once a minute, deleted them
  // mid-test, and the next request answered 401. Nothing here may expire by the wall clock (test/harness.int.test.ts).
  const ttl = await mongo.exec(['mongosh', '--quiet', '--eval', 'db.adminCommand({ setParameter: 1, ttlMonitorEnabled: false })']);
  if (ttl.exitCode !== 0) throw new Error(`could not turn off the TTL monitor: ${ttl.output}`);
  return async () => { await Promise.all([mongo.stop(), valkey.stop()]); };
}
