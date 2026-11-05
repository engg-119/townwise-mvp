import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { calibrationSchema, coverageSchema } from '../schemas';
import type { SalesDay } from './days';

// POST /api/org/locations/:locationId/sales/uploads (spec 10.4; api/src/handlers/sales.ts uploadSales). Kept
// beside the page rather than in the shared schemas.ts, which other pages edit at the same time.

export const uploadViewSchema = z.object({
  id: z.string(),
  uploadedAt: z.string(),
  uploadedByEmail: z.string(),
  status: z.enum(['applying', 'applied']),
  dayCount: z.number(),
  inserted: z.number(),
  replaced: z.number(),
  kept: z.number(),
  firstDate: z.string(),
  lastDate: z.string(),
  hasGuests: z.boolean(),
  hasNetSales: z.boolean(),
});

/** 201: the upload's counts, and the location's coverage and calibration after it. */
export const uploadResponseSchema = z.object({ upload: uploadViewSchema, coverage: coverageSchema, calibration: calibrationSchema });
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export function uploadPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/sales/uploads`;
}

/** One request with `{ days }` and nothing else (spec 11.1). */
export function sendUpload(api: ApiClient, locationId: string, body: { days: SalesDay[] }): Promise<UploadResponse> {
  return api.json(uploadPath(locationId), uploadResponseSchema, { method: 'POST', body });
}
