// Stored files in Azure sign in with the API's managed identity: blobs.ts wraps the shared token source
// (azure-identity.ts) as the storage SDK's TokenCredential, for the storage resource whatever scope the SDK asks for.
import { describe, expect, it } from 'vitest';

import { AzureIdentityError, createManagedIdentityTokenSource, type FetchLike } from '../../src/azure-identity.ts';
import { STORAGE_RESOURCE, storageCredential } from '../../src/files/blobs.ts';

const IDENTITY = {
  endpoint: 'http://localhost:42356/msi/token',
  header: 'identity-header-test-value',
  clientId: '00000000-0000-0000-0000-000000000000',
};
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

describe('the storage credential', () => {
  it('asks the managed identity endpoint for a storage token, once while it is fresh', async () => {
    const urls: URL[] = [];
    const fetch: FetchLike = (url) => {
      urls.push(new URL(url));
      return Promise.resolve(Response.json({ access_token: 'storage-token', expires_on: String(Math.floor(NOW / 1000) + 3600) }));
    };
    const credential = storageCredential(createManagedIdentityTokenSource({ identity: IDENTITY, now: () => new Date(NOW), fetch }));

    const token = await credential.getToken('https://storage.azure.com/.default');
    expect(token).toEqual({ token: 'storage-token', expiresOnTimestamp: (Math.floor(NOW / 1000) + 3600) * 1000 });
    await credential.getToken(['https://storage.azure.com/.default']);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get('resource')).toBe(STORAGE_RESOURCE);
    expect(urls[0]?.searchParams.get('client_id')).toBe(IDENTITY.clientId);
  });

  it('passes a failure on as the identity error, which carries a code and never the endpoint’s answer', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response('secret detail', { status: 500 }));
    const credential = storageCredential(createManagedIdentityTokenSource({ identity: IDENTITY, now: () => new Date(NOW), fetch }));
    const failure = await credential.getToken('https://storage.azure.com/.default').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AzureIdentityError);
    expect(failure).toMatchObject({ code: 'upstream_status', status: 500 });
    expect((failure as Error).message).not.toContain('secret detail');
  });
});
