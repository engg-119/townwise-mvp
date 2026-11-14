import type { Delimiter } from './text';

// Which viewer shows a Your data file, from the API's file kind and the file's name. An image is shown only when its
// bytes match its format's signature (sniffImage), whatever its name says.

export type ViewerKind = 'text' | 'delimited' | 'workbook' | 'pdf' | 'document' | 'image' | 'none';

const DELIMITED = new Set(['csv', 'tsv', 'tab']);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** The lower-case extension after the name's last dot, or '' without one. */
function extensionOf(name: string | null): string {
  if (name === null) return '';
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** `kind` is the API's file kind: 'text', 'xlsx', 'xls', 'pdf', 'docx', 'doc', 'zip' or 'other'. */
export function viewerFor(kind: string, name: string | null): ViewerKind {
  switch (kind) {
    case 'text':
      return DELIMITED.has(extensionOf(name)) ? 'delimited' : 'text';
    case 'xlsx':
      return 'workbook';
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'document';
    case 'other':
      return IMAGES.has(extensionOf(name)) ? 'image' : 'none';
    default:
      return 'none';
  }
}

/** Tab for a .tsv or .tab file; otherwise undefined, so parseDelimited detects the delimiter. */
export function delimiterFor(name: string | null): Delimiter | undefined {
  const extension = extensionOf(name);
  return extension === 'tsv' || extension === 'tab' ? '\t' : undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/** The image type `bytes` really are, by their signature, or null. */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}
