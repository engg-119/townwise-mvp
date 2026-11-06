import { useRef } from 'react';

import { Button } from '../ui/Button';

// The drop step's browser pieces (storage2 2.1): files dropped anywhere on the step, and the picker, which takes
// any number of files of any type. Each File goes to the upload queue as it is; nothing here opens or reads one.
// While the step can't upload (view-as), a drop is caught and ignored, so the browser doesn't open the file in the
// tab either, and the picker is a disabled button with no file input behind it.

function hasFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export function DropArea(props: {
  enabled: boolean;
  onFiles: (files: File[]) => void;
  /** The number of files being dragged over the step (0 when the browser doesn't say), or null when none are. */
  onOver: (count: number | null) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const depth = useRef(0);
  const { enabled, onFiles, onOver } = props;
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        if (enabled) onOver(event.dataTransfer.items.length);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) onOver(null);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        onOver(null);
        const files = Array.from(event.dataTransfer.files);
        if (enabled && files.length > 0) onFiles(files);
      }}
    >
      {props.children}
    </div>
  );
}

export function FilePicker(props: {
  enabled: boolean;
  label: string;
  onFiles: (files: File[]) => void;
  describedBy?: string;
}): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      {props.enabled ? (
        <input
          ref={input}
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          data-testid="history-files"
          style={{ display: 'none' }}
          onChange={(event) => {
            const chosen = Array.from(event.currentTarget.files ?? []);
            // Cleared so the same files can be chosen again.
            event.currentTarget.value = '';
            if (chosen.length > 0) props.onFiles(chosen);
          }}
        />
      ) : null}
      <Button
        variant="outline"
        label={props.label}
        disabled={!props.enabled}
        {...(props.describedBy === undefined ? {} : { describedBy: props.describedBy })}
        onPress={() => { input.current?.click(); }}
      />
    </>
  );
}

export const CAN_DROP = true as boolean;
