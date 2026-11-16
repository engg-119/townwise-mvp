// The test server itself (helpers/server.ts). The laptop CI runner reaches the test Valkey through Docker Desktop's
// forwarded port (host.docker.internal), and at a high load a first connection there took longer than the 3 s that
// three pings allowed: on 2026-11-14 two verify runs each failed one test here at about 3,040 ms. A proxy stands in for a
// path that slows down and recovers: it holds every connection made in the first 4.5 s until then, and passes later
// ones straight on.
import { createServer, connect, type AddressInfo, type Socket } from 'node:net';

import { expect, inject, it } from 'vitest';

import { startAuthServer } from './helpers/server.ts';

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
    const slow = await startAuthServer({ env: { REDIS_URL: `redis://127.0.0.1:${String(port)}` } });
    await slow.close();
    expect(performance.now()).toBeGreaterThan(until);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => { proxy.close(() => { resolve(); }); });
  }
});
