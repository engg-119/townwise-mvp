import mongoose, { type Connection } from 'mongoose';
import { z } from 'zod';

import { ConfigError, type Logger, type ServerConfig, type ShutdownHook } from '@ckeith26/server-core';

const TLS_PROBLEM = 'production requires TLS with certificate and hostname validation';

export const configSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/).meta({ secret: true }),
});

export type MongoConfig = z.infer<typeof configSchema>;

export interface Mongo extends ShutdownHook {
  readonly connection: Connection;
}

/**
 * Production TLS check on the driver's resolved options.
 * URI text misses +srv defaults, tls=false, and the invalid-certificate flags.
 */
export function assertProductionTls(uri: string): void {
  try {
    const options = new mongoose.mongo.MongoClient(uri).options;
    const tls = options.tls
      && options.rejectUnauthorized !== false
      && !options.tlsInsecure
      && options.checkServerIdentity === undefined;
    if (!tls) throw new ConfigError([{ variable: 'MONGODB_URI', problem: TLS_PROBLEM }]);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const name = err instanceof Error ? err.name : 'Error';
    throw new ConfigError([{ variable: 'MONGODB_URI', problem: `${TLS_PROBLEM} (${name})` }]);
  }
}

/** Opens one connection. In production, validates resolved TLS options before any socket. */
export async function connectMongo(deps: {
  config: MongoConfig & Pick<ServerConfig, 'NODE_ENV'>;
  logger: Logger;
}): Promise<Mongo> {
  if (deps.config.NODE_ENV === 'production') assertProductionTls(deps.config.MONGODB_URI);

  const connection = mongoose.createConnection();
  // The createConnection option is ignored. set() is what turns sanitizing on.
  connection.set('sanitizeFilter', true);
  connection.on('disconnected', () => {
    deps.logger.warn('mongo.disconnected');
  });
  connection.on('reconnected', () => {
    deps.logger.info('mongo.reconnected');
  });
  connection.on('error', (err: unknown) => {
    deps.logger.error({ err }, 'mongo.error');
  });

  try {
    await connection.openUri(deps.config.MONGODB_URI, {
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
  } catch (err) {
    try {
      await connection.close();
    } catch {
      // A close failure must not hide the open error.
    }
    throw err;
  }

  return {
    name: 'mongo',
    connection,
    close: async (): Promise<void> => {
      await connection.close();
    },
  };
}
