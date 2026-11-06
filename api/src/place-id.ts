// A Google place id, as the Places proxy (handlers/places.ts, places/google.ts) and access requests accept it.
// Google documents place ids as text with no fixed maximum; the ones seen are URL-safe base64. [CONFIRM: place ID format]
// No trim: an id with a space is refused, not repaired.
import { z } from 'zod';

export const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{10,512}$/;

export const placeIdSchema = z.string().regex(PLACE_ID_PATTERN);
