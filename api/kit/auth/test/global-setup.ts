import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

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
  project.provide('mongoUri', mongo.getConnectionString());
  project.provide('redisUrl', `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`);
  // The tests run on a clock frozen at 2026-06-01 (helpers/server.ts), but mongod's TTL monitor deletes by the wall
  // clock, by which every session and magic link a test writes has long expired. Its pass, once a minute, would delete
  // them mid-test. Nothing here may expire by the wall clock (mongo-stores.int.test.ts pins this).
  const ttl = await mongo.exec(['mongosh', '--quiet', '--eval', 'db.adminCommand({ setParameter: 1, ttlMonitorEnabled: false })']);
  if (ttl.exitCode !== 0) throw new Error(`could not turn off the TTL monitor: ${ttl.output}`);
  return async () => { await Promise.all([mongo.stop(), valkey.stop()]); };
}
