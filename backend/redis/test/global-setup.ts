import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { VALKEY_IMAGE } from './images.ts';

declare module 'vitest' {
  export interface ProvidedContext { redisUrl: string }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const valkey = await new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start();
  project.provide('redisUrl', `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`);
  return async () => { await valkey.stop(); };
}
