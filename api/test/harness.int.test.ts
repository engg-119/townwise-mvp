// The harness itself. Tests run on a clock frozen at 2026-06-01 (helpers/server.ts), so every session and magic link
// they write is long expired by the wall clock that mongod's TTL monitor reads. With the monitor on, a pass (once a
// minute) deleted them mid-test and the next request answered 401 (last-admin-races failed so in CI).
import { createServer, connect, type AddressInfo, type Socket } from 'node:net';

import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { startTownwiseServer, testDatabase, testWorker, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

it('the test database deletes nothing by the wall clock: its TTL monitor is off', async () => {
  const reply = await server.connection.getClient().db('admin').command({ getParameter: 1, ttlMonitorEnabled: 1 });
  expect(reply.ttlMonitorEnabled).toBe(false);
});

// Integration files run side by side (vitest.config.ts), and a server drops its database and flushes its Valkey db at
// start. Each worker has its own of both (helpers/server.ts testWorker), so a server starting in one file leaves the
// data of a file running beside it alone. Valkey db 0 and the database `townwise-test-0` stand in for that neighbor:
// no worker uses either.
it('a server clears only its own worker\'s database and Valkey db, so files can run side by side', async () => {
  const slot = testWorker();
  expect(server.connection.name).toBe(`townwise-test-${String(slot)}`);
  expect(testDatabase()).toBe(server.connection.name);
  expect(server.redis.options.db).toBe(slot);
  const otherDb = server.connection.getClient().db('townwise-test-0');
  const otherRedis = server.redis.duplicate({ db: 0 });
  try {
    await otherDb.collection('neighbor').insertOne({ kept: true });
    await otherRedis.set('neighbor', 'kept');
    await server.redis.set('mine', 'cleared');
    const next = await startTownwiseServer();
    await next.close();
    expect(await otherDb.collection('neighbor').countDocuments()).toBe(1);
    expect(await otherRedis.get('neighbor')).toBe('kept');
    expect(await server.redis.get('mine')).toBeNull();
  } finally {
    await otherDb.dropDatabase();
    await otherRedis.del('neighbor');
    otherRedis.disconnect();
  }
});

// The laptop CI runner reaches the test Valkey through Docker Desktop's forwarded port (host.docker.internal), and at a
// high load a first connection there took longer than the 3 s that three pings allowed: on 2026-11-14 four verify runs
// each failed one suite at about 3,020 ms. A proxy stands in for a path that slows down and recovers: it holds every
// connection made in the first 4.5 s until then, and passes later ones straight on.
it('starts when Redis answers only after longer than three pings', async () => {
  const target = new URL(inject('redisUrl'));
  const sockets = new Set<Socket>();
  const until = performance.now() + 4500;
  const proxy = createServer((socket) => {
    sockets.add(socket);
    socket.pause();
    setTimeout(() => {
      if (socket.destroyed) return;
      const upstream = connect(Number(target.port), target.hostname);
      sockets.add(upstream);
      upstream.on('error', () => { socket.destroy(); });
      socket.on('error', () => { upstream.destroy(); });
      socket.pipe(upstream).pipe(socket);
    }, Math.max(0, until - performance.now()));
  });
  await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve); });
  try {
    const { port } = proxy.address() as AddressInfo;
    const slow = await startTownwiseServer({ env: { REDIS_URL: `redis://127.0.0.1:${String(port)}/${String(testWorker())}` } });
    await slow.close();
    expect(performance.now()).toBeGreaterThan(until);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => { proxy.close(() => { resolve(); }); });
  }
});
