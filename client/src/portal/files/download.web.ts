// Saving a downloaded file on web (storage2 10): the bytes came from the API (a fetch to its origin, which
// `connect-src` allows), so the browser saves them from a `blob:` object URL through a temporary
// `<a download>`. No header changes: a download navigation is not governed by the page's CSP.

export const CAN_SAVE_FILES = true as boolean;

/** How long the object URL stays alive after the click, so a slow save still finds it. */
const REVOKE_AFTER_MS = 40_000;

export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, REVOKE_AFTER_MS);
}
