import { z } from 'zod';

import { ApiError, type ApiClient } from './api/client';

// GET /api/org (api/src/handlers/locations.ts getOwnOrg): only the fields the app reads. Unknown keys are stripped.
const orgSchema = z.object({
  org: z.object({ id: z.string(), name: z.string() }),
  locations: z.array(z.object({
    id: z.string(),
    name: z.string(),
    town: z.object({ name: z.string(), state: z.string() }),
  })),
});

export type Org = z.infer<typeof orgSchema>;
export type OrgLocation = Org['locations'][number];

/** The caller's organization, or `null` when they have none (the member policy answers 403). */
export async function loadOrg(api: ApiClient): Promise<Org | null> {
  try {
    return await api.json('/api/org', orgSchema);
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http' && error.status === 403) return null;
    throw error;
  }
}
