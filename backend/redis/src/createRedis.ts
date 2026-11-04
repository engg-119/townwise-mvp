import type { Logger, ServerConfig, ShutdownHook } from '@ckeith26/server-core';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { parseRedisUrl } from './parseRedisUrl.ts';

export const configSchema = z.object({
  REDIS_URL: z.string().min(1).meta({ secret: true }),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9-]*:$/),
});

export type RedisConfig = z.infer<typeof configSchema>;

export interface RedisHandle extends ShutdownHook {
  readonly client: Redis;
  ready(timeoutMs: number): Promise<boolean>;
}

function errorCode(err: Error): string | number {
  if ('code' in err) {
    const code = err.code;
    if (typeof code === 'string' || typeof code === 'number') return code;
  }
  return err.name;
}

export function createRedis(deps: {
  config: RedisConfig & Pick<ServerConfig, 'NODE_ENV'>;
  logger: Logger;
}): RedisHandle {
  const { config, logger } = deps;
  const parts = parseRedisUrl(config.REDIS_URL, config.NODE_ENV === 'production');
  const client = new Redis({
    host: parts.host,
    port: parts.port,
    db: parts.db,
    keyPrefix: config.REDIS_KEY_PREFIX,
    maxRetriesPerRequest: 2,
    commandTimeout: 1000,
    ...(parts.username !== undefined ? { username: parts.username } : {}),
    ...(parts.password !== undefined ? { password: parts.password } : {}),
    ...(parts.tls ? { tls: {} } : {}),
  });

  client.on('error', (err: Error) => {
    logger.warn({ code: errorCode(err) }, 'redis error');
  });

  const handle: RedisHandle = {
    name: 'redis',
    client,
    async ready(timeoutMs: number): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answered = await Promise.race([
        client.ping().then(() => true, () => false),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => { resolve(false); }, timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (answered) logger.info('redis ready');
      else logger.warn('redis not ready');
      return answered;
    },
    async close(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        client.quit().then(() => undefined, () => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      // quit() resolves before the socket close event. disconnect() ends the
      // socket on the next turn, so wait until the client reports end.
      if (client.status === 'end') {
        client.disconnect();
        return;
      }
      const ended = new Promise<void>((resolve) => {
        client.once('end', () => { resolve(); });
      });
      client.disconnect();
      await ended;
    },
  };
  return handle;
}
