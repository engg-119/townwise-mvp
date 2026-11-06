// Saving a downloaded file (storage 8, storage2 10). Native has no downloads in v1: the file list says to
// download from a computer instead, and never calls saveFile. The web version is download.web.ts.

export const CAN_SAVE_FILES = false as boolean;

/** Same signature as the web version; native has nowhere to save to. */
export function saveFile(...file: [blob: Blob, name: string]): void {
  throw new Error(`Downloads work in a web browser, not here (${String(file.length)}).`);
}
