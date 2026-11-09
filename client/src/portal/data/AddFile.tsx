import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { queueLine } from '../files/copy';
import { useUploadQueue } from '../files/uploadQueue';
import { FilePicker } from '../onboarding/HistoryStepDrop';
import { Mono, Small } from '../ui/text';
import { DATA } from './copy';

// “Add a file” on Your data (D28): any kind of file, up to the stored-file cap, kept as it is for reference. It
// reuses the history drop step's queue with the purpose `reference`: the same chunks, caps and retries. Nothing here
// opens or reads a file. Mounted only on web with stored files on; the queue is stopped when the page closes.

export function AddFile(props: {
  locationId: string;
  enabled: boolean;
  describedBy?: string;
  /** A file finished uploading: the list reloads. */
  onStored: () => void;
}): React.JSX.Element {
  const queue = useUploadQueue(props.locationId, { purpose: 'reference' });
  const { onStored } = props;
  const finished = queue.items.filter((item) => item.state === 'done').length;
  // Told once per finished file, whatever `onStored` is by then.
  const told = useRef(0);
  useEffect(() => {
    if (finished > told.current) onStored();
    told.current = finished;
  }, [finished, onStored]);
  const open = queue.items.filter((item) => item.state !== 'done' && item.state !== 'cancelled');
  return (
    <View style={styles.box}>
      <FilePicker
        enabled={props.enabled}
        label={DATA.addFile}
        onFiles={queue.add}
        {...(props.describedBy === undefined ? {} : { describedBy: props.describedBy })}
      />
      {open.length === 0 ? null : (
        <View role="list" aria-label="Files being added" style={styles.queue}>
          {open.map((item) => (
            <View key={item.key} role="listitem" style={styles.item}>
              <Mono tone="white">{item.name}</Mono>
              <Small>{queueLine(item)}</Small>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: theme.space[3], alignItems: 'flex-start' },
  queue: { gap: theme.space[2], alignSelf: 'stretch' },
  item: { gap: 2, minWidth: 0 },
});
