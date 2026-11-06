import { z } from 'zod';

// The confirm card's map, as POST /api/places/details answers it (api/README.md, Places search): a Google Maps Static
// URL the API signed, which the image loads straight from Google, or null while the map is off. Only a signed URL on
// that one path parses, so a buggy or compromised answer can't make the app load another image. The web CSP's img-src
// allows https://maps.googleapis.com for it (client/MODULE.md, Security). Never log the URL: it carries the key and
// the signature.

export const STATIC_MAP_URL_PREFIX = 'https://maps.googleapis.com/maps/api/staticmap?';
/** Google's signature is an HMAC-SHA1 in URL-safe base64, the URL's last parameter. */
const SIGNED = /&signature=[A-Za-z0-9_-]{27}=?$/;

export const placeMapSchema = z.object({
  url: z.string().max(8192).startsWith(STATIC_MAP_URL_PREFIX).regex(SIGNED),
  width: z.literal(640),
  height: z.literal(320),
}).nullable();

export type PlaceMap = z.infer<typeof placeMapSchema>;
