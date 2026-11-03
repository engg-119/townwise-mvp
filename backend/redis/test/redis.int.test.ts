import { createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger } from '@ckeith26/server-core';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { expect, inject, it } from 'vitest';

import { createRedis, type RedisHandle } from '../src/createRedis.ts';
import { VALKEY_IMAGE } from './images.ts';

function handleFor(url: string): RedisHandle {
  return createRedis({
    config: { NODE_ENV: 'test', REDIS_KEY_PREFIX: 'test:', REDIS_URL: url },
    logger: createLogger({ LOG_LEVEL: 'silent' }),
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close((err) => { if (err) reject(err); else resolve(port); });
    });
  });
}

function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => {
          for (const socket of sockets) socket.destroy();
          server.close((err) => { if (err) fail(err); else done(); });
        }),
      });
    });
  });
}

function startValkey(hostPort: number): Promise<StartedTestContainer> {
  return new GenericContainer(VALKEY_IMAGE).withExposedPorts({ container: 6379, host: hostPort }).start();
}

it('reconnects after a 10s outage', async () => {
  const hostPort = await freePort();
  let first: StartedTestContainer | undefined;
  let replacement: StartedTestContainer | undefined;
  let handle: RedisHandle | undefined;
  try {
    first = await startValkey(hostPort);
    handle = handleFor(`redis://${first.getHost()}:${String(hostPort)}`);
    expect(await handle.ready(3000)).toBe(true);
    await first.stop();
    first = undefined;
    await delay(10_000);
    replacement = await startValkey(hostPort);
    const deadline = performance.now() + 15_000;
    while (handle.client.status !== 'ready') {
      if (performance.now() > deadline) throw new Error(`status stayed ${handle.client.status}`);
      await delay(200);
    }
    await handle.client.set('k', 'v');
    expect(await handle.client.get('k')).toBe('v');
  } finally {
    handle?.client.disconnect();
    await replacement?.stop();
    await first?.stop();
  }
}, 60_000);

it('commands fail within about 1s while Redis is unreachable (no hang)', async () => {
  const port = await freePort();
  const silent = await silentServer();
  const refused = handleFor(`redis://127.0.0.1:${String(port)}`);
  const halfOpen = handleFor(`redis://127.0.0.1:${String(silent.port)}`);
  try {
    const refusedStart = performance.now();
    await expect(refused.client.get('k')).rejects.toThrow();
    expect(performance.now() - refusedStart).toBeLessThan(1500);

    const halfStart = performance.now();
    await expect(halfOpen.client.get('k')).rejects.toThrow();
    expect(performance.now() - halfStart).toBeLessThan(1500);
  } finally {
    refused.client.disconnect();
    halfOpen.client.disconnect();
    await silent.close();
  }
});

it('ready(3000) resolves false within about 1s against a server that accepts TCP and never answers, and true against Valkey', async () => {
  const silent = await silentServer();
  const halfOpen = handleFor(`redis://127.0.0.1:${String(silent.port)}`);
  const live = handleFor(inject('redisUrl'));
  try {
    const start = performance.now();
    expect(await halfOpen.ready(3000)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(await live.ready(3000)).toBe(true);
  } finally {
    halfOpen.client.disconnect();
    live.client.disconnect();
    await silent.close();
  }
});

it('close() resolves while Redis is down', async () => {
  const port = await freePort();
  const handle = handleFor(`redis://127.0.0.1:${String(port)}`);
  try {
    const start = performance.now();
    await handle.close();
    expect(performance.now() - start).toBeLessThan(1500);
    expect(handle.client.status).toBe('end');
  } finally {
    handle.client.disconnect();
  }
});
