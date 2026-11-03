import { MongoDBContainer } from '@testcontainers/mongodb';
import type { TestProject } from 'vitest/node';

import { MONGO_IMAGE } from './images.ts';

declare module 'vitest' {
  export interface ProvidedContext { mongoUri: string }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Docker's default soft limit of 1024 open files aborted mongod mid-run in coffee-chat (WiredTiger error 24).
  // mongo 8.0.32 exits on GitHub's kernel (6.19 and newer, fatal 12257600, SERVER-121912).
  // glibc.pthread.rseq=1 lets that build start; rseq=0 does not.
  const mongo = await new MongoDBContainer(MONGO_IMAGE)
    .withUlimits({ nofile: { soft: 64000, hard: 64000 } })
    .withEnvironment({ GLIBC_TUNABLES: 'glibc.pthread.rseq=1' })
    .start();
  project.provide('mongoUri', mongo.getConnectionString());
  return async () => {
    await mongo.stop();
  };
}
