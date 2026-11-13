import { useCallback, useLayoutEffect, useRef } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { hasCode } from '../../portal/errors';
import { listFiles } from '../../portal/files/api';
import { queueLine } from '../../portal/files/copy';
import { useUploadQueue, type QueuedUpload } from '../../portal/files/uploadQueue';
import { useLoad } from '../../portal/hooks';
import { usePortal } from '../../portal/PortalProvider';
import { webAria } from '../../portal/ui/aria';
import { theme } from '../../theme';
import type { ComposerFileLine, ComposerFiles } from './ComposerFiles';
import { Plus } from './icons';

// The composer's + on web (spec P25, D28): "Add a file to Your data" opens the file picker, and each file goes to
// Your data as a reference file through the queue Your data's "Add a file" uses (the same chunks, caps and retries).
// A reference file is kept and turned on when it finishes, so TownwiseAI can read it there if it is text
// (read_data_item). The + shows only while stored files are on, asked of the first file list as Your data asks (off
// answers 503 files_unavailable), and is off under view-as. Nothing here opens or reads a file.

export const ADD_FILE = 'Add a file to Your data';

const c = theme.color;

/** What the line above the composer says about one file: only a text file is one TownwiseAI can read. */
export function fileLineOf(item: QueuedUpload): ComposerFileLine {
  if (item.state === 'done') {
    const text = item.file?.kind === 'text'
      ? `${item.name} is on Your data. TownwiseAI can read it.`
      : `${item.name} is on Your data. TownwiseAI reads only text files, so it can’t open this one.`;
    return { key: item.key, text, state: 'added' };
  }
  if (item.state === 'refused' || item.state === 'failed') return { key: item.key, text: `${item.name}: ${queueLine(item)}`, state: 'failed' };
  return { key: item.key, text: `Adding ${item.name} to Your data`, state: 'adding' };
}

function AddButton(props: { disabled: boolean; describedBy: string | null; onFiles: (files: File[]) => void }): React.JSX.Element {
  const { disabled } = props;
  const input = useRef<HTMLInputElement | null>(null);
  const button = useRef<React.ComponentRef<typeof Pressable>>(null);
  // As the composer's own button: aria-disabled on the same element keeps its focus, and the press handler is absent.
  useLayoutEffect(() => {
    const element = button.current as unknown as Element | null;
    if (disabled) element?.setAttribute('aria-disabled', 'true');
    else element?.removeAttribute('aria-disabled');
  }, [disabled]);
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
      <Pressable
        ref={button}
        role="button"
        accessibilityLabel={ADD_FILE}
        accessibilityState={{ disabled }}
        {...webAria({ 'aria-describedby': props.describedBy ?? undefined })}
        {...(disabled ? {} : { onPress: () => { input.current?.click(); } })}
        style={(state) => [styles.button, !disabled && (state as { hovered?: boolean }).hovered === true ? styles.buttonHover : null]}
      >
        <Plus color={disabled ? c.text3 : c.white} />
      </Pressable>
    </>
  );
}

export function useComposerFiles(locationId: string, readOnlyId: string | null): ComposerFiles {
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
  const on = probe.state.status === 'ready' && probe.state.data && !queue.filesUnavailable;
  const { items, add, cancel, forget } = queue;
  const clear = useCallback(() => {
    for (const item of items) {
      if (item.state === 'done') forget(item.key);
      else if (item.state === 'refused' || item.state === 'failed') cancel(item.key);
    }
  }, [items, cancel, forget]);
  return {
    button: on ? <AddButton disabled={readOnlyId !== null} describedBy={readOnlyId} onFiles={add} /> : null,
    lines: items.filter((item) => item.state !== 'cancelled').map(fileLineOf),
    clear,
  };
}

const styles = StyleSheet.create({
  button: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: theme.stroke.hairline, borderColor: c.border,
  },
  // Hover only recolors the circle's own border, so it can never reach past the composer's rounded box.
  buttonHover: { borderColor: c.white },
});
