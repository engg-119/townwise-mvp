import type { RedisHandle } from '@ckeith26/redis';

/**
 * Pings until Redis answers or 15 s have passed. One ping gives up near 1 s (the client's commandTimeout), and on the
 * laptop runner a first connection to the test Valkey (through host.docker.internal) now and then takes longer. Three
 * pings were not enough at a high load: on 2026-11-14 four verify runs each failed one suite at about 3,020 ms. Mongo
 * waits 30 s to select a server and the hooks 120 s (test/harness.int.test.ts pins this wait).
 */
export async function waitForRedis(redis: RedisHandle): Promise<void> {
  const deadline = performance.now() + 15_000;
  let ready = await redis.ready(3000);
  while (!ready && performance.now() < deadline) ready = await redis.ready(3000);
  // The status tells a connection still being made (connecting) from one refused or reset (reconnecting).
  if (!ready) throw new Error(`redis not ready after 15 s (client ${redis.client.status})`);
}
