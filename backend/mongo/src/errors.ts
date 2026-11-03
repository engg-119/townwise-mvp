import mongoose from 'mongoose';
import { z } from 'zod';

function hasCode11000(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && 'code' in entry && entry.code === 11000;
}

/** True for a duplicate-key failure, including a bulk write that reports code 11000 on one op. */
export function isDuplicateKeyError(err: unknown): boolean {
  if (!(err instanceof mongoose.mongo.MongoServerError)) return false;
  if (err.code === 11000) return true;
  if (!('writeErrors' in err)) return false;
  const writeErrors: unknown = err.writeErrors;
  if (writeErrors === undefined || writeErrors === null) return false;
  return [writeErrors].flat().some((entry) => hasCode11000(entry));
}

/** 24 hex characters. Chosen per parameter: Google, Stripe and Tavus ids are not ObjectIds. */
export const objectId: z.ZodString = z.string().regex(/^[0-9a-f]{24}$/i);
