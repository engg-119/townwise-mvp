import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { MONGO_IMAGE, VALKEY_IMAGE } from './images.ts';

declare module 'vitest' {
  export interface ProvidedContext { mongoUri: string; redisUrl: string }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [mongo, valkey] = await Promise.all([
    // The kit's settings (api/kit/auth/test/global-setup.ts): a raised open-file limit, and rseq=1 so
    // mongo 8.0.32 starts on newer kernels.
    new MongoDBContainer(MONGO_IMAGE)
      .withUlimits({ nofile: { soft: 64000, hard: 64000 } })
      .withEnvironment({ GLIBC_TUNABLES: 'glibc.pthread.rseq=1' })
      .start(),
    new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start(),
  ]);
  project.provide('mongoUri', mongo.getConnectionString());
  project.provide('redisUrl', `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`);
  return async () => { await Promise.all([mongo.stop(), valkey.stop()]); };
}
