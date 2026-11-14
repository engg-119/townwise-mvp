import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { hasCode } from '../../portal/errors';
import { listFiles } from '../../portal/files/api';
import { queueLine } from '../../portal/files/copy';
import { useUploadQueue, type QueuedUpload } from '../../portal/files/uploadQueue';
import { useLoad } from '../../portal/hooks';
import { usePortal } from '../../portal/PortalProvider';
import { theme } from '../../theme';
import type { AttachmentKind, MessageAttachment } from '../api';
import { KIND_WORD, kindOfFile, MAX_ATTACHMENTS, readable, unreadLine } from '../attachments';
import type { ComposerFiles, FilesLine, TakenFiles } from './ComposerFiles';
import { ChatButton, focusLost } from './controls';
import { Close, Plus } from './icons';

// The composer's files on web (spec P25, D28, D36). "Attach files", the + at the composer's left, opens the file
// picker; each file (or one dropped on the page, ChatDrop.web.tsx) goes to Your data as a reference file through the
// queue Your data's "Add a file" uses (the same chunks, caps and retries), and shows as a chip in the composer:
// uploading with its percent, ready, or failed. A message carries at most 5. The x on a chip takes it off the message
// and stops an upload still running; a file that finished uploading stays on Your data, and the chips say so once.
// Send puts the ready chips' refs on the message (`take`); a turn taken back puts them back (`restore`). Each
// conversation keeps its own chips while the page is open. The + shows only while stored files are on, asked of the
// first file list as Your data asks (off answers 503 files_unavailable), and is off under view-as. Nothing here opens
// or reads a file.

export const ATTACH_FILES = 'Attach files';
export const REMOVED_LINE = 'Removed from this message; it stays on Your data.';
export const WAIT_LINE = 'Send waits until your files finish uploading.';
export const WAIT_ID = 'composer-files-wait';

const c = theme.color;

/** A file on the message, as its chip shows it. */
export interface ComposerChip {
  /** The upload queue's key for the file. */
  key: string;
  name: string;
  kind: AttachmentKind;
  state: 'uploading' | 'ready' | 'failed';
  /** 0 to 99 while uploading, 100 once ready. */
  percent: number;
  /** The stored file's id, once the server made it. */
  fileId: string | null;
}

export function chipOf(item: QueuedUpload): ComposerChip {
  const base = { key: item.key, name: item.name, kind: kindOfFile(item.name, item.file?.kind ?? null), fileId: item.file?.id ?? item.fileId };
  if (item.state === 'done') return { ...base, state: 'ready', percent: 100 };
  if (item.state === 'refused' || item.state === 'failed') return { ...base, state: 'failed', percent: 0 };
  const percent = item.sizeBytes > 0 ? Math.min(99, Math.floor((item.sentBytes / item.sizeBytes) * 100)) : 0;
  return { ...base, state: 'uploading', percent };
}

/** The line under a chip's name: its progress, that it couldn't be added, or its kind (and whether TownwiseAI reads it). */
export function chipLine(chip: ComposerChip): string {
  if (chip.state === 'uploading') return `Uploading ${String(chip.percent)}%`;
  if (chip.state === 'failed') return 'Couldn’t add it';
  return readable(chip.kind) ? KIND_WORD[chip.kind] : unreadLine(chip.kind);
}

function overLine(left: number): string {
  return `A message can carry ${String(MAX_ATTACHMENTS)} files, so ${left === 1 ? '1 wasn’t' : `${String(left)} weren’t`} added.`;
}

/** One conversation's files: the queue keys on its message, and the lines its chips show. */
interface Tray {
  keys: readonly string[];
  /** A file that finished uploading was taken off the message: the chips say it stays on Your data. */
  removed: boolean;
  /** Files past the 5 a message carries, from the last add. */
  over: string | null;
}

interface Trays {
  /** The location the trays are for: another location's start empty. */
  owner: string;
  shown: Tray;
  /** The other conversations' trays, by conversation id ('' for a new one). */
  kept: ReadonlyMap<string, Tray>;
  /** Counts switches, so a send's files come back only to the conversation they left. */
  switches: number;
}

const EMPTY_TRAY: Tray = { keys: [], removed: false, over: null };

function fresh(owner: string): Trays {
  return { owner, shown: EMPTY_TRAY, kept: new Map(), switches: 0 };
}

function trayKey(conversationId: string | null): string {
  return conversationId ?? '';
}

function AddButton(props: { disabled: boolean; describedBy: string | null; onFiles: (files: File[]) => void }): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-testid="composer-files"
        style={{ display: 'none' }}
        onChange={(event) => {
          const chosen = Array.from(event.currentTarget.files ?? []);
          // Cleared so the same file can be chosen again.
          event.currentTarget.value = '';
          if (chosen.length > 0) props.onFiles(chosen);
        }}
      />
      <ChatButton
        variant="arrow"
        round
        label={ATTACH_FILES}
        icon={(color) => <Plus color={color} />}
        disabled={props.disabled}
        describedBy={props.describedBy}
        onPress={() => { input.current?.click(); }}
      />
    </>
  );
}

function Chip(props: { chip: ComposerChip; onRemove: () => void }): React.JSX.Element {
  const { chip } = props;
  return (
    <View role="listitem" style={styles.chip}>
      <View style={styles.chipWords}>
        <Text numberOfLines={1} style={styles.chipName}>{chip.name}</Text>
        <Text style={styles.chipLine}>{chipLine(chip)}</Text>
      </View>
      <ChatButton
        variant="arrow"
        round
        label={`Remove ${chip.name} from this message`}
        icon={(color) => <Close color={color} />}
        onPress={props.onRemove}
      />
    </View>
  );
}

export function useComposerFiles(locationId: string, readOnlyId: string | null, focusComposer: () => void): ComposerFiles {
  const { api } = usePortal();
  const queue = useUploadQueue(locationId, { purpose: 'reference' });
  const probe = useLoad(useCallback(async () => {
    try {
      await listFiles(api, locationId);
      return true;
    } catch (error) {
      return !hasCode(error, 503, 'files_unavailable');
    }
  }, [api, locationId]));
  const available = probe.state.status === 'loading' ? null : probe.state.status === 'ready' && probe.state.data && !queue.filesUnavailable;
  // The trays are drawn from state; event handlers read them from `latest`, set with every change, so a send right
  // after an add sees the file.
  const [trays, setTrays] = useState<Trays>(() => fresh(locationId));
  const latest = useRef(trays);
  const [notice, setNotice] = useState<FilesLine | null>(null);
  const refocus = useRef(false);
  const { items, add: enqueue, cancel } = queue;

  /** The trays now, from an event handler. */
  function now(): Trays {
    return latest.current.owner === locationId ? latest.current : fresh(locationId);
  }

  function set(next: Trays): void {
    latest.current = next;
    setTrays(next);
  }

  // A chip's x took its control off the page: focus goes to the composer, unless the person has put it elsewhere.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (focusLost()) focusComposer();
  });

  const byKey = new Map(items.map((item) => [item.key, item]));
  /** A tray's files the queue still has, in order (a canceled one has left the message). */
  function itemsOf(tray: Tray): QueuedUpload[] {
    return tray.keys.flatMap((key) => {
      const item = byKey.get(key);
      return item === undefined || item.state === 'cancelled' ? [] : [item];
    });
  }

  function add(files: readonly File[]): number {
    if (files.length === 0) return 0;
    const was = now();
    const room = Math.max(0, MAX_ATTACHMENTS - itemsOf(was.shown).length);
    const taking = files.slice(0, room);
    const keys = taking.length === 0 ? [] : enqueue(taking);
    const left = files.length - taking.length;
    set({ ...was, shown: { keys: [...was.shown.keys, ...keys], removed: false, over: left > 0 ? overLine(left) : null } });
    return keys.length;
  }

  function remove(key: string): void {
    const was = now();
    const item = byKey.get(key);
    // An upload still running stops, and the server deletes what it has; a failed one just goes.
    if (item !== undefined && item.state !== 'done') cancel(key);
    const kept = item?.state === 'done';
    set({ ...was, shown: { keys: was.shown.keys.filter((other) => other !== key), removed: was.shown.removed || kept, over: null } });
    if (item?.state === 'done') setNotice({ key: `removed:${key}`, text: `Removed ${item.name} from this message. It stays on Your data.` });
    refocus.current = true;
  }

  function take(): TakenFiles {
    const was = now();
    const sent: QueuedUpload[] = [];
    const staying: string[] = [];
    for (const item of itemsOf(was.shown)) {
      if (item.state === 'done') sent.push(item);
      // Send waits for uploads, so none should be running; one that is stays on the composer.
      else if (item.state === 'refused' || item.state === 'failed') cancel(item.key);
      else staying.push(item.key);
    }
    set({ ...was, shown: { keys: staying, removed: false, over: null } });
    const attachments: MessageAttachment[] = sent.map((item) => {
      const chip = chipOf(item);
      return { ref: `f_${chip.fileId ?? ''}`, kind: chip.kind, name: chip.name, state: 'on' };
    });
    const switches = was.switches;
    const keys = sent.map((item) => item.key);
    return {
      attachments,
      restore: () => {
        const back = now();
        // Only to the conversation they left (a turn holds the page, so that is where the person still is).
        if (back.switches !== switches || keys.length === 0) return;
        set({ ...back, shown: { ...back.shown, keys: [...keys, ...back.shown.keys.filter((key) => !keys.includes(key))] } });
      },
    };
  }

  function switchTo(from: string | null, to: string | null): void {
    const was = now();
    const kept = new Map(was.kept);
    kept.set(trayKey(from), was.shown);
    const shown = kept.get(trayKey(to)) ?? EMPTY_TRAY;
    kept.delete(trayKey(to));
    set({ ...was, shown: { ...shown, over: null }, kept, switches: was.switches + 1 });
    setNotice(null);
  }

  const shown = trays.owner === locationId ? trays.shown : EMPTY_TRAY;
  const shownItems = itemsOf(shown);
  const chips = shownItems.map(chipOf);
  const uploading = chips.some((chip) => chip.state === 'uploading');
  const alerts: FilesLine[] = [
    ...shownItems.flatMap((item) => (item.state === 'refused' || item.state === 'failed' ? [{ key: `failed:${item.key}`, text: `${item.name}: ${queueLine(item)}` }] : [])),
    ...(shown.over === null ? [] : [{ key: 'over', text: shown.over }]),
  ];
  const news: FilesLine[] = [
    ...chips.flatMap((chip) => (chip.state === 'ready'
      ? [{ key: `ready:${chip.key}`, text: readable(chip.kind) ? `${chip.name} is attached.` : `${chip.name} is attached. ${unreadLine(chip.kind)}.` }]
      : [])),
    ...(notice === null ? [] : [notice]),
  ];
  const tray = chips.length === 0 && !shown.removed ? null : (
    <View style={styles.tray}>
      {chips.length === 0 ? null : (
        <View role="list" accessibilityLabel="Files attached to your message" style={styles.chips}>
          {chips.map((chip) => <Chip key={chip.key} chip={chip} onRemove={() => { remove(chip.key); }} />)}
        </View>
      )}
      {uploading ? <Text nativeID={WAIT_ID} style={styles.line}>{WAIT_LINE}</Text> : null}
      {shown.removed ? <Text style={styles.line}>{REMOVED_LINE}</Text> : null}
    </View>
  );
  return {
    button: available === true ? <AddButton disabled={readOnlyId !== null} describedBy={readOnlyId} onFiles={(chosen) => { add(chosen); }} /> : null,
    chips: tray,
    count: chips.length,
    uploading,
    waitId: uploading ? WAIT_ID : null,
    alerts,
    news,
    available,
    add,
    take,
    switchTo,
  };
}

const styles = StyleSheet.create({
  // A first row inside the composer's box, in normal flow, so the dock's measured height takes it in.
  tray: { gap: theme.space[2], paddingHorizontal: theme.space[1], paddingTop: theme.space[1] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  // Rounded like the person's bubble (spec 15.6's TownwiseAI exception): a square chip would poke past the box's corner.
  chip: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44, maxWidth: 280, minWidth: 0, paddingLeft: theme.space[3],
    borderRadius: 16, borderWidth: theme.stroke.hairline, borderColor: c.border, backgroundColor: c.panel,
  },
  chipWords: { flexShrink: 1, minWidth: 0, paddingVertical: theme.space[1] },
  chipName: { ...theme.type.ui, color: c.white },
  chipLine: { ...theme.type.mono, color: c.text2 },
  line: { ...theme.type.small, color: c.text2, paddingHorizontal: theme.space[2] },
});
