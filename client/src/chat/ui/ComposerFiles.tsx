import type { MessageAttachment } from '../api';

// The composer's files (spec P25, D28, D36): the + that attaches files to the message, each kept on Your data, and
// the chips that show them in the composer. Web only, like Your data's "Add a file": the picker and the stored-files
// upload are web, so native has no + and no chips (D20). ComposerFiles.web.tsx draws them.

/** A line for the page, by a key it is said or shown once under. */
export interface FilesLine { key: string; text: string }

/** What the message's files are when it goes: their attachments, and a way to put them back if the turn is taken back. */
export interface TakenFiles {
  attachments: MessageAttachment[];
  restore: () => void;
}

export interface ComposerFiles {
  /** The + for the composer's leading slot; null where it doesn't show (native, or stored files off). */
  button: React.JSX.Element | null;
  /** The chips for the composer's attachments slot; null when the message has none and there is nothing to say. */
  chips: React.JSX.Element | null;
  /** Files on the message now, in any state. */
  count: number;
  /** A file on the message is still uploading: Send waits, described by `waitId`. */
  uploading: boolean;
  /** The id of the line that says why Send waits, while a file uploads; else null. */
  waitId: string | null;
  /** Errors for above the composer: a file that couldn't be added, or files past the 5 a message can carry. */
  alerts: readonly FilesLine[];
  /** Sentences for the page's polite region, each said once: a file attached, or one removed from the message. */
  news: readonly FilesLine[];
  /** Whether stored files are on here (asked as Your data asks); null until known; false on native. */
  available: boolean | null;
  /** Files to attach to the message (the + or a drop): each goes to Your data, at most 5 on a message. Answers how many it took. */
  add: (files: readonly File[]) => number;
  /** Sending: the ready files go with the message and leave the composer; one that failed is dropped. */
  take: () => TakenFiles;
  /** The person opened another conversation (`to`; null for a new one): the files shown are kept for `from`. */
  switchTo: (from: string | null, to: string | null) => void;
}

const NONE: ComposerFiles = {
  button: null, chips: null, count: 0, uploading: false, waitId: null, alerts: [], news: [], available: false,
  add: () => 0,
  take: () => ({ attachments: [], restore: () => undefined }),
  switchTo: () => undefined,
};

export const useComposerFiles: (locationId: string, readOnlyId: string | null, focusComposer: () => void) => ComposerFiles = () => NONE;
