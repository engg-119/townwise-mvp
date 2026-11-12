import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePortal } from '../../PortalProvider';
import { itemHref } from '../../routing';
import { Actions, Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Messages } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { useFocusMessage } from '../../ui/messageFocus';
import { Small } from '../../ui/text';
import type { DataItem } from '../api';
import { EDIT, keptLine, replaceRetryable, storeErrorLine } from './copy';
import {
  encodedLike, gridOfRows, gridOfSheet, sameGrid, tableBytes, workbookBytes, type EditableOpened, type Grid, type Saved,
} from './edit';
import { GridEditor, WorkbookEditor } from './GridEditor.web';
import { replaceStored, saveAsCopy, saveInPlace, type EditTarget, type SaveResult } from './save';
import { TextEditor } from './TextEditor.web';

// Editing a stored file in its viewer's place on its item page (P27, web; FileView.web.tsx opens it). Text is a
// textarea and a CSV, TSV or workbook a grid of inputs, drafted from what the viewer opened. Save stays disabled until
// the draft differs from the file. Text and CSV save in place (save.ts saveInPlace: a new upload under the item's
// name, then replace) and a workbook as a values-only copy beside it (saveAsCopy); either way the page then opens the
// saved item with a line saying so. Cancel asks before it drops changes.
//
// Failures say what happened and what to do, and focus moves to that line (ui/messageFocus.tsx). An upload refused or
// failed changed nothing, so the draft stays open to save again. An upload that stored but didn't take the item's
// place is its own item now: a failure that may not have reached the API offers Try again, which replaces with the
// same file id (retry-safe); one that can't succeed (another edit came first) says so, with a link to the new item.
// While a save runs the inputs are read-only, Cancel waits, and `onSaving` tells the page so its actions wait too.

type Draft = { kind: 'text'; text: string } | { kind: 'table'; grid: Grid } | { kind: 'workbook'; grids: Grid[] };

type Phase =
  /** `error`: why the last save stored nothing. */
  | { at: 'editing'; error: string | null }
  | { at: 'saving' }
  /** Stored as `f_<fileId>`, not yet in the item's place; Try again may finish it. */
  | { at: 'not_replaced'; fileId: string; retrying: boolean }
  /** Stored as `f_<fileId>`, which stays a new item. */
  | { at: 'kept'; fileId: string; line: string };

function draftOf(opened: EditableOpened): Draft {
  switch (opened.viewer) {
    case 'text': return { kind: 'text', text: opened.text };
    case 'delimited': return { kind: 'table', grid: gridOfRows(opened.table.rows) };
    case 'workbook': return { kind: 'workbook', grids: opened.workbook.sheets.map(gridOfSheet) };
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
  if (a.kind === 'table' && b.kind === 'table') return sameGrid(a.grid, b.grid);
  if (a.kind === 'workbook' && b.kind === 'workbook') {
    return a.grids.length === b.grids.length && a.grids.every((grid, index) => {
      const other = b.grids[index];
      return other !== undefined && sameGrid(grid, other);
    });
  }
  return false;
}

function bytesOf(opened: EditableOpened, draft: Draft): Uint8Array {
  if (opened.viewer === 'text' && draft.kind === 'text') return encodedLike(draft.text, opened);
  if (opened.viewer === 'delimited' && draft.kind === 'table') return tableBytes(opened.table, draft.grid, opened);
  if (opened.viewer === 'workbook' && draft.kind === 'workbook') return workbookBytes(opened.workbook, draft.grids);
  throw new Error('The draft is not of what opened.');
}

export interface ItemEditorProps {
  item: DataItem;
  opened: EditableOpened;
  /** The item's name as the page shows it, for the editor's accessible names. */
  name: string;
  onSaving: (saving: boolean) => void;
  onClose: () => void;
  openRef: (ref: string, saved?: Saved) => void;
}

export function ItemEditor(props: ItemEditorProps): React.JSX.Element {
  const { api } = usePortal();
  const { item, opened, onSaving, openRef } = props;
  const [original] = useState(() => draftOf(opened));
  const [draft, setDraft] = useState(original);
  const [phase, setPhase] = useState<Phase>({ at: 'editing', error: null });
  const [confirming, setConfirming] = useState(false);
  const focusMessage = useFocusMessage();
  // A save the person left keeps running (save.ts); its answer then changes nothing here.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const changeGrid = useCallback((update: (grid: Grid) => Grid) => {
    setDraft((current) => (current.kind === 'table' ? { ...current, grid: update(current.grid) } : current));
  }, []);
  const changeSheet = useCallback((sheet: number, update: (grid: Grid) => Grid) => {
    setDraft((current) => (current.kind === 'workbook'
      ? { ...current, grids: current.grids.map((grid, index) => (index === sheet ? update(grid) : grid)) }
      : current));
  }, []);

  const copy = draft.kind === 'workbook';
  const changed = useMemo(() => !sameDraft(original, draft), [original, draft]);
  const saving = phase.at === 'saving' || (phase.at === 'not_replaced' && phase.retrying);
  const target: EditTarget = { locationId: item.locationId, ref: item.ref, name: item.name ?? props.name };

  const settle = (result: SaveResult): void => {
    if (!mounted.current) return;
    onSaving(false);
    if (result.at === 'saved') {
      openRef(result.ref, copy ? 'copy' : 'edited');
      return;
    }
    if (result.at === 'not_stored') setPhase({ at: 'editing', error: storeErrorLine(result.code, result.detail) });
    else if (replaceRetryable(result.error)) setPhase({ at: 'not_replaced', fileId: result.fileId, retrying: false });
    else setPhase({ at: 'kept', fileId: result.fileId, line: keptLine(result.error) });
    focusMessage();
  };
  const failed = (): void => { settle({ at: 'not_stored', code: 'internal', detail: null }); };

  const save = (): void => {
    if (!changed || phase.at !== 'editing') return;
    const bytes = bytesOf(opened, draft);
    setPhase({ at: 'saving' });
    onSaving(true);
    (copy ? saveAsCopy(api, target, bytes) : saveInPlace(api, target, bytes)).then(settle, failed);
  };

  const retry = (): void => {
    if (phase.at !== 'not_replaced' || phase.retrying) return;
    setPhase({ ...phase, retrying: true });
    onSaving(true);
    replaceStored(api, target, phase.fileId).then(settle, failed);
  };

  const cancel = (): void => {
    if (saving) return;
    if (changed && phase.at === 'editing') setConfirming(true);
    else props.onClose();
  };

  const stored = phase.at === 'not_replaced' || phase.at === 'kept';
  let surface: React.ReactNode = null;
  if (!stored) {
    if (draft.kind === 'text') {
      surface = <TextEditor text={draft.text} label={`Text of ${props.name}`} disabled={saving} onChange={(text) => { setDraft({ kind: 'text', text }); }} />;
    } else if (draft.kind === 'table') {
      surface = <GridEditor grid={draft.grid} label={`Rows of ${props.name}`} letters={false} disabled={saving} autoFocus onChange={changeGrid} />;
    } else if (opened.viewer === 'workbook') {
      surface = <WorkbookEditor names={opened.workbook.sheets.map((sheet) => sheet.name)} grids={draft.grids} disabled={saving} onChange={changeSheet} />;
    }
  }

  return (
    <Stack>
      {surface}
      {phase.at === 'editing' && phase.error !== null ? <Messages live="alert" takesFocus items={[phase.error]} /> : null}
      {phase.at === 'not_replaced' ? (
        <Stack>
          <Messages live="alert" takesFocus items={[EDIT.notReplaced]} />
          <Actions>
            <Button variant="outline" label={phase.retrying ? EDIT.tryingAgain : EDIT.tryAgain} disabled={phase.retrying} onPress={retry} />
            <Button variant="link" label={EDIT.close} disabled={phase.retrying} onPress={props.onClose} />
          </Actions>
        </Stack>
      ) : null}
      {phase.at === 'kept' ? (
        <Stack>
          <Messages
            live="alert"
            takesFocus
            items={[phase.line]}
            link={{ label: EDIT.openKept, href: itemHref(item.locationId, `f_${phase.fileId}`) }}
          />
          <Actions>
            <Button variant="link" label={EDIT.close} onPress={props.onClose} />
          </Actions>
        </Stack>
      ) : null}
      {stored ? null : (
        <Stack>
          {copy ? <Small>{EDIT.copyNote}</Small> : null}
          <Actions>
            <Button variant="primary" label={saving ? EDIT.saving : copy ? EDIT.saveCopy : EDIT.save} disabled={!changed || saving} onPress={save} />
            <Button variant="link" label={EDIT.cancel} disabled={saving} onPress={cancel} />
          </Actions>
        </Stack>
      )}
      <ConfirmDialog
        visible={confirming}
        title={EDIT.discardTitle}
        body={EDIT.discardBody}
        confirmLabel={EDIT.discardConfirm}
        onConfirm={() => { setConfirming(false); props.onClose(); }}
        onCancel={() => { setConfirming(false); }}
      />
    </Stack>
  );
}
