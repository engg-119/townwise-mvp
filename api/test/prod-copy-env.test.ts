import { describe, expect, it } from 'vitest';

import { PROD_COPY_OFF, prodCopyEnv } from '../scripts/prod-copy-env.ts';

describe('prodCopyEnv (the local API on the production copy)', () => {
  const local = {
    PORT: '8080', MONGODB_URI: 'mongodb://localhost:27017/townwise?directConnection=true', ANTHROPIC_API_KEY: 'k',
    FILES_BLOB_ACCOUNT_URL: 'http://127.0.0.1:10000/devstoreaccount1', FILES_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    EMAIL_ENDPOINT: 'https://x.communication.azure.com', EMAIL_SENDER: 'a@b.c', TOWNWISE_CALENDAR_KEY: 'c',
    TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID: 'id', TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET: 's',
  };

  it('switches the database to townwise_prod on the same server, keeping its options', () => {
    expect(prodCopyEnv(local).MONGODB_URI).toBe('mongodb://localhost:27017/townwise_prod?directConnection=true');
  });

  it('turns off stored files (the boot sweeper would delete local blobs), email and calendars, and keeps the rest', () => {
    const env = prodCopyEnv(local);
    for (const name of PROD_COPY_OFF) expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject({ PORT: '8080', ANTHROPIC_API_KEY: 'k' });
  });

  it('never points at a database that is not local', () => {
    expect(() => prodCopyEnv({ ...local, MONGODB_URI: 'mongodb://db.example.com:10260/townwise' })).toThrow(/local MongoDB/);
    expect(() => prodCopyEnv({ PORT: '8080' })).toThrow(/MONGODB_URI/);
  });
});
