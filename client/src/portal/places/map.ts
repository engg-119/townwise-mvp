import { Platform } from 'react-native';
import { z } from 'zod';

import { getThemeMode, useThemeMode, type ThemeMode } from '../shell/themeMode';

// The confirm card's map, as POST /api/places/details answers it, and the checklist's map of every checked place, as
// POST /api/places/map answers it (api/README.md, Places search): a Google Maps Static URL the API signed, at most
// Google's 16,384 characters, which the image loads straight from Google, or null while the map is off. Only a signed URL on
// that one path parses, so a buggy or compromised answer can't make the app load another image. The web CSP's img-src
// allows https://maps.googleapis.com for it (client/MODULE.md, Security). Never log the URL: it carries the key and
// the signature.
// Both requests send `theme` in the body, the mode the API signs the map in: the portal's light or dark on web
// (shell/themeMode.ts), always dark on native, where the apps stay dark.

export const STATIC_MAP_URL_PREFIX = 'https://maps.googleapis.com/maps/api/staticmap?';
/** Google's signature is an HMAC-SHA1 in URL-safe base64, the URL's last parameter. */
const SIGNED = /&signature=[A-Za-z0-9_-]{27}=?$/;

export const placeMapSchema = z.object({
  url: z.string().max(16_384).startsWith(STATIC_MAP_URL_PREFIX).regex(SIGNED),
  width: z.literal(640),
  height: z.literal(320),
}).nullable();

export type PlaceMap = z.infer<typeof placeMapSchema>;

/**
 * The mode a map is asked for in, re-rendering when the person or the system switches it. Picked once per platform, so
 * native, which stays dark, never reads the mode's store (shell/themeMode.ts).
 */
export const useMapTheme: () => ThemeMode = Platform.OS === 'web' ? useThemeMode : () => 'dark';

/** The same, read once: for a request sent from an event, such as the details call when a place is picked. */
export function mapThemeNow(): ThemeMode {
  return Platform.OS === 'web' ? getThemeMode() : 'dark';
}
