import { useEffect, useMemo, useState } from 'react';

import { ApiError } from '../../../api/client';
import { downloadClean, downloadRaw } from '../../files/api';
import { ZipEntries } from '../../files/ZipEntries';
import { usePortal } from '../../PortalProvider';
import { EmptyState, ErrorNotice, LoadingLine } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { ViewerError } from '../../viewer/errors';
import { delimiterFor } from '../../viewer/kinds';
import type { DataItem } from '../api';
import { dataError, shownName } from '../copy';
import {
  cantShowLine, fetchingLine, ITEM, openingLine, tooLargeLine, VIEWER_ERROR, withDownload,
} from './copy';
import { DocumentView } from './DocumentView.web';
import { editableOf, isEditable, type Saved } from './edit';
import { ItemEditor } from './Editor.web';
import { DelimitedView, WorkbookView } from './GridView.web';
import { ImageView } from './ImageView.web';
import type { ItemEdit } from './ItemContent';
import { afterPaint, bytesOf, openBytes, planFor, type Blocked, type Opened, type Which } from './open';
import { PdfView } from './PdfView.web';
import { TextView } from './TextView.web';

// A stored file drawn in the browser on its item page (P27, web): the original, or a sales file's cleaned copy. planFor
// decides whether to fetch it at all; every case that shows nothing says why, in plain words, and how to open the file
// instead when the person may download it. The fetch shows "Downloading…", then "Opening {size} file…" for a frame
// before the parse, which can hold the page for a moment on a large file.
//
// Editing: this component owns what was opened (`Opened`, the bytes and the parsed model: the text with its encoding
// and byte-order mark, the Delimited table, the Workbook). Once an original is open it tells the page whether that can
// be edited here (`edit.onEditable`, edit.ts editableOf), and while the page's editor is open, ItemEditor takes the
// same model in OpenedView's place. The fetch runs again only when what it fetches changes (the file, which copy, its
// viewer), not when the item is read again after a rename.

type Phase =
  | { at: 'fetching' }
  | { at: 'opening'; sizeBytes: number }
  | { at: 'open'; opened: Opened }
  | { at: 'failed'; error: unknown };

export interface FileViewProps {
  item: DataItem;
  which: Which;
  viewAs: boolean;
  /** Editing the original in the viewer's place (a stored file's page; the page decides who may). */
  edit?: ItemEdit;
  openRef?: (ref: string, saved?: Saved) => void;
}

function blockedLine(blocked: Blocked, item: DataItem, canDownload: boolean): string {
  switch (blocked.why) {
    case 'view_as': return ITEM.viewAs;
    case 'files_off': return ITEM.filesOff;
    case 'uploading': return ITEM.uploading;
    case 'raw_gone': return ITEM.rawGone;
    case 'kind': return withDownload(cantShowLine(blocked.kind, item.name), canDownload);
    case 'not_allowed': return ITEM.notAllowed;
    case 'too_large': return withDownload(tooLargeLine(blocked.sizeBytes), canDownload);
  }
}

/** The one switch from what was opened to what draws it. */
function OpenedView(props: { opened: Opened; name: string; canDownload: boolean }): React.JSX.Element {
  const { opened, name } = props;
  switch (opened.viewer) {
    case 'text': return <TextView text={opened.text} label={`Text of ${name}`} />;
    case 'delimited': return <DelimitedView table={opened.table} label={`Rows of ${name}`} />;
    case 'workbook': return <WorkbookView workbook={opened.workbook} />;
    case 'pdf': return <PdfView bytes={opened.bytes} title={`PDF: ${name}`} />;
    case 'document': return <DocumentView blocks={opened.blocks} truncated={opened.truncated} label={`Contents of ${name}`} />;
    case 'image':
      return opened.type === null
        ? <EmptyState text={withDownload(ITEM.notImage, props.canDownload)} />
        : <ImageView bytes={opened.bytes} type={opened.type} alt={name} />;
  }
}

export function FileView(props: FileViewProps): React.JSX.Element {
  const { api } = usePortal();
  const { item, which } = props;
  const plan = planFor(item, which, props.viewAs);
  const file = item.file;
  const canDownload = !props.viewAs && file !== null && file.canDownloadRaw && file.rawAvailable;

  // What the fetch depends on, as plain values, so reading the item again (a rename) does not fetch the file again.
  const locationId = item.locationId;
  const fileId = file?.id ?? '';
  const fetching = 'blocked' in plan ? null : plan.fetch;
  const viewer = 'blocked' in plan ? null : plan.viewer;
  const sizeBytes = 'blocked' in plan ? null : plan.sizeBytes;
  // The cleaned copy is always comma-separated; an original by its name.
  const delimiter = fetching === 'clean' ? ',' : delimiterFor(item.name);
  const [attempt, setAttempt] = useState(0);
  const key = `${fetching ?? ''}:${viewer ?? ''}:${fileId}:${String(sizeBytes)}:${delimiter ?? ''}:${String(attempt)}`;
  const [result, setResult] = useState<{ key: string; phase: Phase } | null>(null);
  const opened = !('blocked' in plan) && result?.key === key && result.phase.at === 'open' ? result.phase.opened : null;
  const editable = useMemo(() => (opened === null || which !== 'raw' ? null : editableOf(opened)), [opened, which]);
  const onEditable = props.edit?.onEditable;
  useEffect(() => {
    onEditable?.(editable);
  }, [onEditable, editable]);
  useEffect(() => () => { onEditable?.(null); }, [onEditable]);

  useEffect(() => {
    if (fetching === null || viewer === null) return undefined;
    const controller = new AbortController();
    // A function, not a flag read inline: TypeScript would keep a flag narrowed across the awaits.
    const live = (): boolean => !controller.signal.aborted;
    const opts = { signal: controller.signal };
    const blob = fetching === 'raw'
      ? downloadRaw(api, locationId, { id: fileId, sizeBytes: sizeBytes ?? 0 }, opts)
      : downloadClean(api, locationId, fileId, opts);
    blob
      .then(bytesOf)
      .then(async (bytes) => {
        if (!live()) return;
        setResult({ key, phase: { at: 'opening', sizeBytes: bytes.length } });
        await afterPaint();
        if (!live()) return;
        const opened = await openBytes(viewer, bytes, delimiter);
        if (live()) setResult({ key, phase: { at: 'open', opened } });
      })
      .catch((error: unknown) => { if (live()) setResult({ key, phase: { at: 'failed', error } }); });
    return () => { controller.abort(); };
  }, [api, key, fetching, viewer, locationId, fileId, sizeBytes, delimiter]);

  if ('blocked' in plan) {
    // A ZIP's entries, as the list shows them (ZipEntries), in place of what can't be drawn.
    const zip = plan.blocked.why === 'kind' && plan.blocked.kind === 'zip' && file !== null ? file.entries : null;
    return (
      <Stack>
        <EmptyState text={blockedLine(plan.blocked, item, canDownload)} />
        {zip === null || file === null ? null : (
          <ZipEntries locationId={item.locationId} file={{ id: file.id, name: item.name, kind: 'zip', uploadedAt: item.addedAt }} entries={zip} />
        )}
      </Stack>
    );
  }
  const phase: Phase = result?.key === key ? result.phase : { at: 'fetching' };
  switch (phase.at) {
    case 'fetching':
      return <LoadingLine text={sizeBytes === null ? ITEM.fetchingClean : fetchingLine(sizeBytes)} />;
    case 'opening':
      return <LoadingLine text={openingLine(phase.sizeBytes)} />;
    case 'failed': {
      const { error } = phase;
      if (error instanceof ViewerError) return <EmptyState text={withDownload(VIEWER_ERROR[error.reason], canDownload)} />;
      if (error instanceof ApiError) return <ErrorNotice message={dataError(error)} onRetry={() => { setAttempt((n) => n + 1); }} />;
      return <EmptyState text={withDownload(ITEM.openFailed, canDownload)} />;
    }
    case 'open': {
      const name = which === 'clean' ? `the cleaned copy of ${shownName(item)}` : shownName(item);
      const { edit, openRef } = props;
      if (edit?.open === true && editable?.fits === true && openRef !== undefined && isEditable(phase.opened)) {
        return <ItemEditor item={item} opened={phase.opened} name={name} onSaving={edit.onSaving} onClose={edit.onClose} openRef={openRef} />;
      }
      return <OpenedView opened={phase.opened} name={name} canDownload={canDownload} />;
    }
  }
}
