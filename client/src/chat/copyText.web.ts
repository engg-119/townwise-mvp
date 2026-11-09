// Copying a reply's text on web through the browser's clipboard. Resolves false when the browser has none or refuses
// (no permission, a page that isn't focused), so the button can say it couldn't.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
