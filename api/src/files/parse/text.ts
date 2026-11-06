// A text file's encoding (spec 11A), decided on its first 64 KiB: UTF-16 by its byte-order mark, else strict UTF-8,
// else windows-1252 (Excel on Windows saves CSV that way). The decoder then streams, so a character split across two
// pieces decodes whole.

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export const ENCODING_PROBE_BYTES = 64 * 1024;

/** The encoding of a text file that starts with `probe` (its first 64 KiB, or all of it). */
export function detectEncoding(probe: Uint8Array): TextEncoding {
  if (probe[0] === 0xff && probe[1] === 0xfe) return 'utf-16le';
  if (probe[0] === 0xfe && probe[1] === 0xff) return 'utf-16be';
  try {
    // stream: true, so a character cut off at the end of the probe is not an error.
    new TextDecoder('utf-8', { fatal: true }).decode(probe, { stream: true });
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/** The report's name for an encoding. */
export function encodingLabel(encoding: TextEncoding): 'utf-8' | 'utf-16' | 'windows-1252' {
  return encoding === 'utf-16le' || encoding === 'utf-16be' ? 'utf-16' : encoding;
}

/** A streaming decoder. UTF-8 stays strict, so bytes that are not UTF-8 later in the file throw (bad_encoding). */
export function decoderFor(encoding: TextEncoding): TextDecoder {
  return new TextDecoder(encoding, { fatal: encoding === 'utf-8' });
}
