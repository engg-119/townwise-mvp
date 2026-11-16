// The pure parts of fetch.mts (README.md here), on strings and Uint8Array bytes with no Node-only global, so a jest
// test can import this file: the icon links in a page's HTML, a PNG's signature, and the largest PNG entry of an ICO.
// Only PNG is kept: SVG, BMP (an ICO's DIB entries too), JPEG and anything else is refused, so that site gets the globe.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether the bytes start with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, at) => bytes[at] === byte);
}

/** A PNG's pixel area from its IHDR chunk (width and height, big-endian, at bytes 16 and 20); 0 when too short. */
function pngArea(bytes: Uint8Array): number {
  if (bytes.length < 24) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

/**
 * The largest PNG entry of an ICO file, or null when the bytes are not an icon file or hold no PNG entry. The
 * directory is 6 bytes (reserved 0, type 1, count) and then 16 bytes an entry, its data's size at 8 and offset at 12.
 */
export function largestPngInIco(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null;
  let best: { area: number; data: Uint8Array } | null = null;
  for (let index = 0; index < view.getUint16(4, true); index += 1) {
    const at = 6 + 16 * index;
    if (at + 16 > bytes.length) break;
    const size = view.getUint32(at + 8, true);
    const offset = view.getUint32(at + 12, true);
    if (offset + size > bytes.length) continue;
    const data = bytes.subarray(offset, offset + size);
    if (!isPng(data)) continue;
    const area = pngArea(data);
    if (best === null || area > best.area || (area === best.area && data.length > best.data.length)) best = { area, data };
  }
  return best === null ? null : best.data.slice();
}

/** The PNG to keep from an icon response: the PNG itself, an ICO's largest PNG entry, or null for anything else. */
export function pngOf(bytes: Uint8Array): Uint8Array | null {
  if (isPng(bytes)) return bytes;
  return largestPngInIco(bytes);
}

/** A tag's attributes, names in lower case, an ampersand's entity (`&amp;`, `&#038;`) decoded in values. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const [, name = '', double, single, bare] = match;
    found.set(name.toLowerCase(), (double ?? single ?? bare ?? '').replace(/&(?:amp|#0*38);/g, '&'));
  }
  return found;
}

/** The largest width a `sizes` attribute names ("16x16 32x32" is 32); 0 for none or "any". */
function largestSize(sizes: string | undefined): number {
  const widths = [...(sizes ?? '').matchAll(/(\d+)x\d+/gi)].map((match) => Number(match[1]));
  return widths.length === 0 ? 0 : Math.max(...widths);
}

/** What a `<link rel="icon">` names: its type, or, with none, its path's extension; null for anything else. */
function linkKind(found: Map<string, string>, url: URL): 'png' | 'ico' | null {
  const type = found.get('type')?.toLowerCase();
  if (type === 'image/png') return 'png';
  if (type === 'image/x-icon' || type === 'image/vnd.microsoft.icon') return 'ico';
  if (type !== undefined) return null;
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.png')) return 'png';
  return path.endsWith('.ico') ? 'ico' : null;
}

/** An https URL for `href` against `base`, or null for one that doesn't parse or isn't https. */
function httpsUrl(href: string, base: string): URL | null {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The icon URLs a page names, in the order to try them: its apple-touch-icon links, then its PNG icon links, then the
 * ICO files its icon links name (a favicon kept away from /favicon.ico, whose largest PNG entry may be the logo), each
 * group largest first by `sizes` (the page's order on a tie), resolved against `base`, the page's own URL after
 * redirects. The caller tries /favicon.ico after these.
 */
export function iconLinks(html: string, base: string): string[] {
  const touch: { url: string; size: number }[] = [];
  const pngs: { url: string; size: number }[] = [];
  const icos: { url: string; size: number }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const found = attributes(tag);
    const rels = (found.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = found.get('href') ?? '';
    const url = href === '' ? null : httpsUrl(href, base);
    if (url === null) continue;
    const entry = { url: url.href, size: largestSize(found.get('sizes')) };
    const kind = rels.includes('icon') ? linkKind(found, url) : null;
    if (rels.some((rel) => rel.startsWith('apple-touch-icon'))) touch.push(entry);
    else if (kind === 'png') pngs.push(entry);
    else if (kind === 'ico') icos.push(entry);
  }
  // Array.prototype.sort is stable, so a tie keeps the page's order.
  const largestFirst = (list: { url: string; size: number }[]): string[] => [...list].sort((a, b) => b.size - a.size).map((entry) => entry.url);
  return [...largestFirst(touch), ...largestFirst(pngs), ...largestFirst(icos)];
}
