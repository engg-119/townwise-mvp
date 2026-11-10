// Copying a reply's text. Native has no clipboard module (it would be a new native dependency, as D20 and D21 avoid),
// so a reply offers no Copy there and keeps its text selectable for the system's own Copy; this answers false.
// copyText.web.ts is the web version.

export const copyText: (text: string) => Promise<boolean> = () => Promise.resolve(false);
