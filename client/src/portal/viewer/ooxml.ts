import { ViewerError } from './errors';
import { VIEW_LIMITS } from './limits';
import { listZip, readZipEntry, readZipEntryPrefix, type ZipEntry } from './zip';

// What .xlsx and .docx share: an Open Packaging (ZIP) container of XML parts found through relationship parts. Parts
// are matched by name without regard to case, elements by local name without regard to prefix or namespace (so
// Strict and Transitional packages read alike), and every part is size-capped before DOMParser sees it. A DOCTYPE is
// refused, so no entity is ever expanded. Every read of a part, the same part read again included, is charged against
// one budget of inflated bytes per opened package (VIEW_LIMITS.zipTotalBytes), so a package that names one large part
// many times cannot make the reader inflate more than the ZIP guards allow once.

/** The OLE compound-file signature: an encrypted (password-protected) Office file, or an old binary .xls or .doc. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export interface Package {
  readonly bytes: Uint8Array;
  readonly parts: ReadonlyMap<string, ZipEntry>;
  /** The inflated bytes reads of this package may still take, from VIEW_LIMITS.zipTotalBytes (charge). */
  readonly budget: { left: number };
}

export interface Relationship {
  readonly id: string;
  readonly type: string;
  /** The target part's name, resolved against the source part. */
  readonly target: string;
}

/** True when `bytes` holds the ASCII `text` as UTF-16LE (how a compound file names its streams). */
function hasUtf16Text(bytes: Uint8Array, text: string): boolean {
  const last = bytes.length - text.length * 2;
  for (let at = 0; at <= last; at += 1) {
    let k = 0;
    while (k < text.length && bytes[at + 2 * k] === text.charCodeAt(k) && bytes[at + 2 * k + 1] === 0) k += 1;
    if (k === text.length) return true;
  }
  return false;
}

/** Throws when `bytes` is an OLE compound file: `encrypted` when it holds an encrypted package, else `unsupported`. */
function refuseOle(bytes: Uint8Array): void {
  if (bytes.length < OLE_SIGNATURE.length || OLE_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return;
  throw new ViewerError(hasUtf16Text(bytes, 'EncryptedPackage') ? 'encrypted' : 'unsupported', 'ole container');
}

/** The package's parts, after the ZIP guards. Two parts whose names differ only in case make it damaged. */
export function openPackage(bytes: Uint8Array): Package {
  refuseOle(bytes);
  const parts = new Map<string, ZipEntry>();
  for (const entry of listZip(bytes)) {
    if (entry.name.endsWith('/')) continue;
    const key = entry.name.replace(/^\/+/, '').toLowerCase();
    if (parts.has(key)) throw new ViewerError('damaged', 'duplicate part');
    parts.set(key, entry);
  }
  return { bytes, parts, budget: { left: VIEW_LIMITS.zipTotalBytes } };
}

/**
 * Takes the most a read may inflate (`bytes`: the entry's declared size, or the prefix read's cap when smaller) from the
 * package's budget, before anything is inflated. Inflating stops at that size (zip.ts), so the charge is never short.
 */
function charge(pkg: Package, bytes: number): void {
  if (bytes > pkg.budget.left) throw new ViewerError('too_big', 'package total');
  pkg.budget.left -= bytes;
}

function partOf(pkg: Package, name: string): ZipEntry | undefined {
  return pkg.parts.get(name.replace(/^\/+/, '').toLowerCase());
}

function decodeXml(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

/** A parsed XML document. DOCTYPEs and parse errors make it damaged. */
export function parseXml(text: string): Document {
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  if (/<!DOCTYPE/i.test(clean)) throw new ViewerError('damaged', 'doctype');
  const doc = new DOMParser().parseFromString(clean, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new ViewerError('damaged', 'xml');
  return doc;
}

/** A part's XML, or null when the package has no such part. Past VIEW_LIMITS.xmlBytes it is too big. */
export async function readXml(pkg: Package, name: string): Promise<Document | null> {
  const entry = partOf(pkg, name);
  if (entry === undefined) return null;
  // A part over the cap is refused before inflating (readZipEntry), so it costs only what it could have read.
  charge(pkg, Math.min(entry.size, VIEW_LIMITS.xmlBytes));
  return parseXml(decodeXml(await readZipEntry(pkg.bytes, entry, VIEW_LIMITS.xmlBytes)));
}

/** The closing tags a cut may end at, with any namespace prefix: literal patterns, made fresh per cut (they're global). */
const CLOSING_TAG = {
  row: () => /<\/([A-Za-z_][\w.-]*:)?row\s*>/g,
  si: () => /<\/([A-Za-z_][\w.-]*:)?si\s*>/g,
} as const;

/**
 * A part's XML, cut when it is larger than VIEW_LIMITS.xmlBytes: the text is kept up to the last whole `element`
 * (the last `</row>` of a worksheet, say) and closed with `closers`, outermost last. `cut` says whether it was.
 * Null when the package has no such part; too big when not one whole `element` fits.
 */
export async function readXmlCut(
  pkg: Package, name: string, element: keyof typeof CLOSING_TAG, closers: readonly string[],
): Promise<{ doc: Document; cut: boolean } | null> {
  const entry = partOf(pkg, name);
  if (entry === undefined) return null;
  charge(pkg, Math.min(entry.size, VIEW_LIMITS.xmlBytes));
  const read = await readZipEntryPrefix(pkg.bytes, entry, VIEW_LIMITS.xmlBytes);
  const text = decodeXml(read.data);
  if (read.complete) return { doc: parseXml(text), cut: false };
  const close = CLOSING_TAG[element]();
  let last: RegExpExecArray | null = null;
  for (let match = close.exec(text); match !== null; match = close.exec(text)) last = match;
  if (last === null) throw new ViewerError('too_big', 'xml part');
  const prefix = last[1] ?? '';
  const kept = text.slice(0, last.index + last[0].length) + closers.map((closer) => `</${prefix}${closer}>`).join('');
  return { doc: parseXml(kept), cut: true };
}

function directoryOf(partName: string): string {
  const slash = partName.lastIndexOf('/');
  return slash === -1 ? '' : partName.slice(0, slash + 1);
}

/** `target` resolved against the folder `base` ('' for the package root, else ending in '/'). */
export function resolvePart(base: string, target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : base + target;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

/** The internal relationships of `partName` ('' for the package's own, in _rels/.rels). */
export async function relationships(pkg: Package, partName: string): Promise<Relationship[]> {
  const base = directoryOf(partName);
  const relsName = partName === '' ? '_rels/.rels' : `${base}_rels/${partName.slice(base.length)}.rels`;
  const doc = await readXml(pkg, relsName);
  if (doc === null) return [];
  const found: Relationship[] = [];
  for (const rel of childElements(doc.documentElement, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const type = rel.getAttribute('Type');
    const target = rel.getAttribute('Target');
    if (id === null || type === null || target === null || rel.getAttribute('TargetMode') === 'External') continue;
    found.push({ id, type, target: resolvePart(base, target) });
  }
  return found;
}

/** The first relationship whose type ends in `/kind` (Transitional and Strict type URIs end alike). */
export function relationshipOf(rels: readonly Relationship[], kind: string): Relationship | undefined {
  return rels.find((rel) => rel.type.endsWith(`/${kind}`));
}

/** The element children of `parent`, optionally only those with local name `localName`. */
export function childElements(parent: Element | null | undefined, localName?: string): Element[] {
  const found: Element[] = [];
  if (parent === null || parent === undefined) return found;
  for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (localName === undefined || child.localName === localName) found.push(child);
  }
  return found;
}

/** The first element child with local name `localName`. */
export function childElement(parent: Element | null | undefined, localName: string): Element | undefined {
  if (parent === null || parent === undefined) return undefined;
  for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.localName === localName) return child;
  }
  return undefined;
}

/** The value of the attribute with local name `localName` in any namespace (w:val, r:id), or null. */
export function attributeOf(element: Element, localName: string, namespaced: boolean): string | null {
  const { attributes } = element;
  for (let i = 0; i < attributes.length; i += 1) {
    const attribute = attributes.item(i);
    if (attribute?.localName === localName && (attribute.namespaceURI !== null) === namespaced) return attribute.value;
  }
  return null;
}

/** Runs `read`; anything it throws that is not a ViewerError (a stack overflow on deep nesting, say) is `damaged`. */
export async function readingPackage<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ViewerError) throw error;
    throw new ViewerError('damaged', 'unreadable package');
  }
}
