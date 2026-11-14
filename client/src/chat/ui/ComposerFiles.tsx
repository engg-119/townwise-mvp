// The composer's + (spec P25, D28): add a file to Your data from the chat, where TownwiseAI can read a text file.
// Web only, like Your data's "Add a file": the picker and the stored-files upload are web, so native has no +.
// ComposerFiles.web.tsx draws it.

export interface ComposerFileLine {
  key: string;
  text: string;
  /** Still going, on Your data, or refused or failed. */
  state: 'adding' | 'added' | 'failed';
}

export interface ComposerFiles {
  /** The + for the composer's leading slot; null where it doesn't show (native, or stored files off). */
  button: React.JSX.Element | null;
  /** One line per file being added, or added since the last message, for above the composer. */
  lines: readonly ComposerFileLine[];
  /** A message went: the lines of files that finished, or were refused, before it go. */
  clear: () => void;
}

const NONE: ComposerFiles = { button: null, lines: [], clear: () => undefined };

export const useComposerFiles: (locationId: string, readOnlyId: string | null) => ComposerFiles = () => NONE;
