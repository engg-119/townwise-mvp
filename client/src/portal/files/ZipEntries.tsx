import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { ErrorNotice, Messages } from '../ui/feedback';
import { Button } from '../ui/Button';
import { Mono, Small } from '../ui/text';
import { listEntries, type EntryView, type FileView } from './api';

/** What the entry list needs of a file: its id, and the pieces of its name. */
export type ZipFile = Pick<FileView, 'id' | 'name' | 'kind' | 'uploadedAt'>;
import { actionError, COPY, entriesLine, entryLine, fileName, formatSize, KIND_LABEL } from './copy';

// A ZIP's count and “See what’s inside”, its paginated entry list (storage2 2.2): on the drop step and in Your
// data. Entries load 200 a page, in archive order; the names print only where the API sends them (never under
// view-as).

function Entries(props: { locationId: string; file: ZipFile }): React.JSX.Element {
  const { api } = usePortal();
  const [pages, setPages] = useState<{ entries: EntryView[]; next: number | null }[]>([]);
  const [more, setMore] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: null });
  const { state, reload } = useLoad(useCallback(
    () => listEntries(api, props.locationId, props.file.id),
    [api, props.locationId, props.file.id],
  ));
  if (state.status === 'loading') return <Small>Loading the files inside…</Small>;
  if (state.status === 'failed') return <ErrorNotice message={actionError(state.error)} onRetry={reload} />;
  const all = [state.data, ...pages];
  const next = all.at(-1)?.next ?? null;
  const showMore = (): void => {
    if (next === null || more.pending) return;
    setMore({ pending: true, error: null });
    listEntries(api, props.locationId, props.file.id, { after: next }).then(
      (page) => { setPages((list) => [...list, page]); setMore({ pending: false, error: null }); },
      (error: unknown) => { setMore({ pending: false, error }); },
    );
  };
  return (
    <View role="list" aria-label={`Files inside ${fileName(props.file)}`} style={styles.entries}>
      {all.flatMap((page) => page.entries).map((entry) => (
        <View key={entry.index} role="listitem" style={styles.entry}>
          <Mono tone="white">{entry.path ?? KIND_LABEL[entry.kind]}</Mono>
          <Small>{`${formatSize(entry.sizeBytes)} · ${entryLine(entry)}`}</Small>
        </View>
      ))}
      {more.error === null ? null : <Messages live="alert" items={[actionError(more.error)]} />}
      {next === null ? null : <Button variant="link" label={more.pending ? 'Loading…' : COPY.moreEntries} disabled={more.pending} onPress={showMore} />}
    </View>
  );
}

export function ZipEntries(props: { locationId: string; file: ZipFile; entries: NonNullable<FileView['entries']> }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.zip}>
      <Small>{entriesLine(props.entries)}</Small>
      <Pressable role="button" aria-expanded={open} onPress={() => { setOpen((value) => !value); }} style={styles.toggle}>
        <Text style={styles.toggleText}>{open ? COPY.hideEntries : COPY.showEntries}</Text>
      </Pressable>
      {open ? <Entries locationId={props.locationId} file={props.file} /> : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  zip: { gap: theme.space[2] },
  toggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  toggleText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  entries: { gap: theme.space[2], paddingLeft: theme.space[4], borderLeftWidth: 1, borderLeftColor: c.border },
  entry: { gap: 2, minWidth: 0 },
});
