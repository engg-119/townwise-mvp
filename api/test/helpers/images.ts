// The same pins as compose.yaml (and the kit's api/kit/mongo/test/images.ts, api/kit/redis/test/images.ts).
export const MONGO_IMAGE =
  'mongo:8.0.32@sha256:d0d926f94df099bff534b7ee5b5986458131a22489dfff8664509af0c1e2ca9c';

export const VALKEY_IMAGE =
  'valkey/valkey:8.1.10-alpine@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507';

/** Blob storage for the stored-files tests (files-azurite.int.test.ts); compose.yaml uses the same pin. 3.37.0, 2026-08-25. */
export const AZURITE_IMAGE =
  'mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5';
