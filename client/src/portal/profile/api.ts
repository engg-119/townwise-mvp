import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The display name (GET and PATCH /api/me/profile, policy member): the name TownwiseAI greets the person by.
// `askName` is true only when there is no stored name, no prefill from the access request, and no view-as.
// The name travels in these bodies only; it is never put in a URL, a log or an audit event.

export const profileSchema = z.object({ displayName: z.string().nullable(), askName: z.boolean() });
export type Profile = z.infer<typeof profileSchema>;

export function fetchProfile(api: ApiClient): Promise<Profile> {
  return api.json('/api/me/profile', profileSchema);
}

/** PATCH { displayName }: null means "no name", and also answers the one-time prompt's Not now. */
export function saveProfile(api: ApiClient, displayName: string | null): Promise<Profile> {
  return api.json('/api/me/profile', profileSchema, { method: 'PATCH', body: { displayName } });
}
