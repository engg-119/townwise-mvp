import mongoose from 'mongoose';
import { inject } from 'vitest';

/** Container URI with the kit_test database and directConnection, so the driver does not discover the replica-set hostname. */
export function testUri(options?: { password?: string }): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = '/kit_test';
  url.searchParams.set('directConnection', 'true');
  if (options?.password !== undefined) {
    url.username = 'kit';
    url.password = options.password;
  }
  return url.toString();
}

/** Drops kit_test. Users survive a drop, so a test that creates one drops the user itself. */
export async function resetDatabase(): Promise<void> {
  const connection = mongoose.createConnection();
  try {
    await connection.openUri(testUri(), { serverSelectionTimeoutMS: 5000 });
    await connection.dropDatabase();
  } finally {
    try {
      await connection.close();
    } catch {
      // The open error is the one that matters.
    }
  }
}
