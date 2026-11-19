import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { rowLines, statusWords } from '../calendar/calendars';
import { COPY as FILE_COPY, formatSize } from '../files/copy';
import { ZipEntries } from '../files/ZipEntries';
import { formatDate } from '../format';
import { itemHref } from '../routing';
import { Skeleton, SkeletonTable, SkeletonText, SkeletonWords } from '../skeleton';
import { webAria } from '../ui/aria';
import { DataTable, RowLink, type Column, type Row } from '../ui/DataTable';
import { Small } from '../ui/text';
import { rowAiLine } from './aiCopy';
import type { DataCalendar, DataItem } from './api';
import { addedLine, COLUMNS, DATA, daysLine, folderCountLine, isReference, itemName, kindLabel, shownName, stateLine, VIA_LINE } from './copy';
import type { DataView } from './dataView';
import { byFolder, FOLDERS, type Entry, type Folder } from './folders';

// Your data's one list (D61): every upload, stored file and calendar, as a table (DataTable) of the same columns.
// "Newest first" is one table, newest at the top. "Organized" is the folders (folders.ts), each a button naming the
// folder and its count that opens its own table in place under it (aria-expanded, and aria-controls on web), all
// closed at first; an empty folder opens to a line saying so. A row opens its item's page from a press anywhere on it,
// its name the row's one link (RowLink); an item still uploading has nothing to open, so its row is not linked. A
// calendar's row names it, its kind and event count ("File, 12 events"), and opens its page (`c_<id>`, D49); its
// status shows only when a refresh failed. Opening is a read, so rows and folders work under view-as too. While the
// list loads, DataListSkeleton draws the view's own shapes: the folders' rows, or the table with the same columns.

export function DataList(props: {
  view: DataView;
  entries: readonly Entry[];
  /** Every location's: a Location column, named by `nameOf`. */
  all: boolean;
  nameOf: (locationId: string) => string;
  /** The table's name ("Your data for Main Street Bar"); a folder's table is named by the folder, then this. */
  label: string;
  /** An older page is still to load, so the folders' counts are of what is loaded. */
  more: boolean;
}): React.JSX.Element {
  const columns = columnsOf(props.all);
  const rowsOf = (entries: readonly Entry[]): Row[] => entries.map((entry) => rowOf(entry, props.nameOf));
  if (props.view === 'newest') return <DataTable label={props.label} columns={columns} rows={rowsOf(props.entries)} />;
  return <Folders entries={props.entries} label={props.label} more={props.more} render={(name, entries) => (
    <DataTable label={`${name}, ${props.label}`} columns={columns} rows={rowsOf(entries)} />
  )} />;
}

/** The list's columns; `all`: every location's, with a Location column. */
function columnsOf(all: boolean): Column[] {
  return [
    { key: 'item', label: COLUMNS.item, flex: 1.6 },
    ...(all ? [{ key: 'location', label: COLUMNS.location, flex: 1.1 }] : []),
    { key: 'added', label: COLUMNS.added, flex: 1.5 },
    { key: 'kind', label: COLUMNS.kind, flex: 1 },
    { key: 'size', label: COLUMNS.size, flex: 0.8 },
    { key: 'status', label: COLUMNS.status, flex: 1.4 },
    { key: 'days', label: COLUMNS.days, flex: 1.4 },
  ];
}

/**
 * The list while it loads (spec 15.7), in the view's own shapes so nothing moves when it arrives: Organized as a row
 * for each folder, its name in place and its count a bar; Newest first as the table, with the same columns (the
 * Location column under All locations). `label`: the page's loading words.
 */
export function DataListSkeleton(props: { view: DataView; all: boolean; label: string }): React.JSX.Element {
  return (
    <Skeleton name="data" label={props.label}>
      {props.view === 'newest' ? (
        // The name's 44px link and the cell's padding.
        <View testID="skeleton-data-table"><SkeletonTable columns={columnsOf(props.all)} rowHeight={56} /></View>
      ) : (
        <View>
          {FOLDERS.map((folder) => (
            <View key={folder.key} testID="skeleton-data-folder" style={styles.folder}>
              <View style={styles.folderButton}>
                <View style={styles.square} />
                <Text style={styles.folderName}><SkeletonWords>{folder.label}</SkeletonWords></Text>
                <SkeletonText type="mono" width={16} />
              </View>
            </View>
          ))}
        </View>
      )}
    </Skeleton>
  );
}

function Folders(props: {
  entries: readonly Entry[];
  label: string;
  more: boolean;
  render: (name: string, entries: readonly Entry[]) => React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<Folder>>(new Set());
  const toggle = (folder: Folder): void => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  };
  return (
    <View style={styles.folders}>
      {props.more ? <Small>{DATA.foldersSoFar}</Small> : null}
      <View role="list" aria-label={`Folders, ${props.label}`}>
        {byFolder(props.entries).map(({ folder, entries }) => {
          const isOpen = open.has(folder.key);
          const id = `data-folder-${folder.key}`;
          return (
            <View key={folder.key} role="listitem" style={styles.folder}>
              <Pressable
                role="button"
                aria-expanded={isOpen}
                accessibilityLabel={folderCountLine(folder.label, entries.length)}
                {...webAria({ 'aria-controls': isOpen ? id : undefined })}
                onPress={() => { toggle(folder.key); }}
                style={styles.folderButton}
              >
                <View style={[styles.square, isOpen ? styles.squareOn : null]} />
                <Text style={[styles.folderName, isOpen ? styles.folderNameOn : null]}>{folder.label}</Text>
                <Text style={styles.count}>{String(entries.length)}</Text>
              </Pressable>
              {isOpen ? (
                <View nativeID={id} style={styles.contents}>
                  {folder.key === 'unsorted' ? <Small>{DATA.unsortedHelp}</Small> : null}
                  {entries.length === 0 ? <Small>{DATA.folderEmpty}</Small> : props.render(folder.label, entries)}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function rowOf(entry: Entry, nameOf: (locationId: string) => string): Row {
  if (entry.type === 'calendar') return calendarRow(entry.calendar, nameOf);
  const { item } = entry;
  return {
    key: item.ref,
    // An item still uploading has nothing to open yet.
    ...(item.state === 'uploading' ? {} : { href: itemHref(item.locationId, item.ref) }),
    cells: {
      item: <ItemCell item={item} />,
      location: nameOf(item.locationId),
      added: addedLine(item),
      kind: kindLabel(item.kind),
      size: item.sizeBytes === null ? DATA.noFileKept : formatSize(item.sizeBytes),
      status: <StatusCell item={item} />,
      days: daysLine(item.days),
    },
  };
}

function calendarRow(calendar: DataCalendar, nameOf: (locationId: string) => string): Row {
  const href = itemHref(calendar.locationId, `c_${calendar.id}`);
  const lines = rowLines(calendar);
  const status = statusWords(calendar.status, calendar.kind);
  return {
    key: `c_${calendar.id}`,
    href,
    cells: {
      item: (
        <View style={styles.cell}>
          <RowLink href={href} label={calendar.label} accessibilityLabel={`${calendar.label}. ${lines.summary}`} />
          <Text style={styles.note}>{lines.summary}</Text>
        </View>
      ),
      location: nameOf(calendar.locationId),
      added: formatDate(calendar.createdAt),
      kind: DATA.calendarKind,
      size: '',
      status: status === null && lines.updated === null ? '' : (
        <View style={styles.cell}>
          {status === null ? null : <Text style={styles.note}>{status}</Text>}
          {lines.updated === null ? null : <Text style={styles.note}>{lines.updated}</Text>}
        </View>
      ),
      days: '',
    },
  };
}

function ItemCell(props: { item: DataItem }): React.JSX.Element {
  const { item } = props;
  const entries = item.file?.entries ?? null;
  return (
    <View style={styles.cell}>
      {item.state === 'uploading' ? <Text style={styles.name}>{shownName(item)}</Text> : (
        <RowLink href={itemHref(item.locationId, item.ref)} label={shownName(item)} accessibilityLabel={itemName(item)} />
      )}
      <Text style={styles.note}>{VIA_LINE[item.via]}</Text>
      {/* Deleted by a person or by retention. An item kept for reference has no cleaned copy or days to keep. */}
      {item.file === null || item.file.rawAvailable || item.state === 'uploading' || isReference(item) ? null : (
        <Text style={styles.note}>{FILE_COPY.rawGone}</Text>
      )}
      {item.file === null || entries === null ? null : (
        <ZipEntries
          locationId={item.locationId}
          file={{ id: item.file.id, name: item.name, kind: item.kind === 'daily_totals' ? 'other' : item.kind, uploadedAt: item.addedAt }}
          entries={entries}
        />
      )}
    </View>
  );
}

/** On or Off, then what Townwise did and, once someone let TownwiseAI read the file, what TownwiseAI did (D34). */
function StatusCell(props: { item: DataItem }): React.JSX.Element {
  const { item } = props;
  const ai = rowAiLine(item.ai);
  return (
    <View style={styles.cell}>
      <Text style={styles.value}>{item.enabled ? DATA.on : DATA.off}</Text>
      <Text style={styles.note}>{ai === null ? stateLine(item) : `${stateLine(item)} · ${ai}`}</Text>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  cell: { gap: 2, minWidth: 0 },
  name: { ...theme.type.mono, color: c.white },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  note: { ...theme.type.small, color: c.text2 },
  folders: { gap: theme.space[2] },
  folder: { borderBottomWidth: 1, borderBottomColor: c.border },
  folderButton: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, paddingHorizontal: 8 },
  square: { width: 6, height: 6, borderWidth: 1, borderColor: c.line },
  squareOn: { backgroundColor: c.mint, borderColor: c.mint },
  folderName: { ...theme.type.ui, color: c.white, flex: 1, minWidth: 0 },
  folderNameOn: { color: c.mint },
  count: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  contents: { gap: theme.space[2], paddingBottom: theme.space[3] },
});
