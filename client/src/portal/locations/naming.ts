import type { PlaceKind } from '../schemas';

// How the portal names a location (spec D29). With one location a member never sees its own name: member pages show
// the organization's name in its place (shownLocationName) and the header eyebrow is the town alone (locationEyebrow).
// A new location's Name starts as “{Business name}, {Town}” (defaultLocationName), since an organization's
// restaurants are likely in different towns. The staff console always shows the stored name. Nothing here is stored.

/** The most characters a location's name takes (the API's 80). */
const MAX_NAME = 80;

/** A letter or digit in any script; `undefined` (the text's edge) is not. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/**
 * `text` holds `word` as a whole word, ignoring case; with `atEnd`, as its last word. A plain search with its edges
 * checked, never a pattern built from the word, so a town's punctuation is matched as written.
 */
function holdsWord(text: string, word: string, atEnd = false): boolean {
  const name = word.trim().toLocaleLowerCase();
  if (name === '') return false;
  const hay = text.trim().toLocaleLowerCase();
  for (let at = hay.indexOf(name); at !== -1; at = hay.indexOf(name, at + 1)) {
    const end = at + name.length;
    const before = Array.from(hay.slice(0, at)).at(-1);
    const after = Array.from(hay.slice(end))[0];
    if (!isWordChar(before) && (atEnd ? end === hay.length : !isWordChar(after))) return true;
  }
  return false;
}

/**
 * A new location's default Name: Google's name for a business, or the organization's for a street address or a place
 * with no name, then “, {Town}” unless that base already says its town (“Hanover Inn”). Cut so the town stays within
 * 80 characters.
 */
export function defaultLocationName(
  place: { name: string | null; kind: PlaceKind; town: { name: string } }, orgName: string,
): string {
  const own = place.kind === 'business' ? (place.name ?? '').trim() : '';
  const base = own === '' ? orgName.trim() : own;
  const town = place.town.name.trim();
  const room = MAX_NAME - town.length - 2;
  if (holdsWord(base, town) || room < 1) return base.slice(0, MAX_NAME).trim();
  return `${base.slice(0, room).trim()}, ${town}`;
}

/** The name a member page shows for a location: its own with several locations, the organization's with one. */
export function shownLocationName(location: { name: string }, org: { org: { name: string }; locations: readonly unknown[] }): string {
  return org.locations.length > 1 ? location.name : org.org.name;
}

/**
 * The location header's eyebrow: “{Town}, {ST}” with one location; with several, “{name}, {ST}” when the name already
 * ends with its town, else “{name}, {Town}, {ST}”.
 */
export function locationEyebrow(location: { name: string; town: { name: string; state: string } }, several: boolean): string {
  const { town } = location;
  if (!several) return `${town.name}, ${town.state}`;
  const name = location.name.trim();
  return holdsWord(name, town.name, true) ? `${name}, ${town.state}` : `${name}, ${town.name}, ${town.state}`;
}
