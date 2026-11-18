import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../../api/client';
import { theme } from '../../../theme';
import { usePortal } from '../../PortalProvider';
import { itemHref, locationHref } from '../../routing';
import { Actions, Button, LinkButton } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Messages, Notice } from '../../ui/feedback';
import { Panel, Stack } from '../../ui/layout';
import { useFocusMessage } from '../../ui/messageFocus';
import { Heading, Small } from '../../ui/text';
import {
  AI, aiError, cantReadLine, daysLine, forecastLine, guardLine, itemLine, kindFoundLine, noteLine, notesLine, rulesSuggestedLine, settledLine,
  undidLine, undoBody,
} from '../aiCopy';
import { readWithAi, undoAiRead, type AiRead, type DataItem } from '../api';

// The TownwiseAI section of an item's page (P27, D34, spec 11A.9), on web and native, for an item with a stored file
// (an `f_` item, or an upload read from one). Before a read, or after one that failed, was skipped or was undone, the
// people who may ask (`canAiRead`) get what reading sends and does, the privacy link and “Let TownwiseAI read this
// file”; a kind TownwiseAI can't read says why instead. While it reads, the item is read again every 3 seconds until
// the read settles; leaving the page stops that. A done read shows what TownwiseAI found and what it added, each with
// its link or why not (D46: how many closure rules it suggested, linked to Business rules), and, for the person who
// asked or an org admin, Undo behind a confirm dialog; so does a read that
// failed or was skipped after it began adding (`canUndo`), with a line that it may have added some. Under view-as the
// API sends no summary, facts or note titles and no rights, so only the statuses show. The line that says how an
// action ended takes focus (ui/messageFocus.tsx), since each action takes its button away.

const POLL_MS = 3000;
const RUNNING: ReadonlySet<string> = new Set(['queued', 'reading']);

export function AiSection(props: {
  item: DataItem;
  /** Shows the item an action answered with, then reads it again. */
  showItem: (item: DataItem) => void;
  /** Reads the item again, keeping what is shown meanwhile. */
  reload: () => void;
}): React.JSX.Element | null {
  const { item, showItem, reload } = props;
  const { api } = usePortal();
  const { ai } = item;
  const running = ai !== null && RUNNING.has(ai.status);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Whether this page saw the read running: its end is then said as a notice.
  const [sawRunning, setSawRunning] = useState(false);
  if (running && !sawRunning) setSawRunning(true);
  const focusMessage = useFocusMessage();
  // Asked one update after the action ends: in that update a closing dialog's focus trap still holds focus.
  const [ended, setEnded] = useState(0);
  useEffect(() => { if (ended > 0) focusMessage(); }, [ended, focusMessage]);

  // While TownwiseAI reads, the item is read again 3 seconds after each answer. `ai` is a new object each time.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setTimeout(reload, POLL_MS);
    return () => { clearTimeout(timer); };
  }, [running, ai, reload]);

  const failed = (error: unknown): void => {
    setFailure(aiError(error));
    setEnded((n) => n + 1);
    // The item may have changed meanwhile (a read started elsewhere, the file deleted): read it again.
    if (error instanceof ApiError && error.kind === 'http') reload();
  };
  const ask = (): void => {
    if (asking) return;
    setAsking(true);
    setFailure(null);
    setNotice(null);
    readWithAi(api, item.locationId, item.ref).then(
      (next) => { setAsking(false); showItem(next); setEnded((n) => n + 1); },
      (error: unknown) => { setAsking(false); failed(error); },
    );
  };
  const undo = (): void => {
    if (undoing) return;
    setUndoing(true);
    setFailure(null);
    undoAiRead(api, item.locationId, item.ref).then(
      (answer) => {
        setUndoing(false);
        setConfirming(false);
        setNotice(undidLine(answer.calibrationKept));
        showItem(answer.item);
        setEnded((n) => n + 1);
      },
      (error: unknown) => { setUndoing(false); setConfirming(false); failed(error); },
    );
  };

  if (item.file === null || item.fromAiRead !== null) return null;
  if (ai === null && !item.canAiRead && notice === null && failure === null) return null;

  // The status, said as a notice when it changes in front of the person, else as a plain line.
  let announced: string | null = null;
  let line: string | null = null;
  if (running) announced = ai.status === 'queued' ? AI.queued : AI.reading;
  else if (notice !== null) announced = notice;
  else if (ai !== null) {
    const settled = ai.status === 'done' ? AI.finished : settledLine(ai);
    if (sawRunning) announced = settled;
    else if (ai.status !== 'done') line = settled;
  }
  const askable = !running && ai?.status !== 'done';
  const cantRead = cantReadLine(item);

  return (
    <Panel label={AI.heading}>
      <Heading level={3}>{AI.heading}</Heading>
      {announced === null ? null : <Notice text={announced} />}
      {line === null ? null : <Small>{line}</Small>}
      {failure === null ? null : <Messages live="alert" takesFocus items={[failure]} />}
      {ai?.status === 'done' ? <Done ai={ai} locationId={item.locationId} onUndo={() => { setFailure(null); setConfirming(true); }} /> : null}
      {ai !== null && ai.status !== 'done' && !running && ai.canUndo ? (
        <Stack gap={theme.space[3]}>
          <Small>{AI.stopped}</Small>
          <Actions>
            <Button variant="outline" label={AI.undo} onPress={() => { setFailure(null); setConfirming(true); }} />
          </Actions>
        </Stack>
      ) : null}
      {askable && item.canAiRead ? (
        cantRead === null ? (
          <Stack gap={theme.space[3]}>
            <Small>{AI.explain}</Small>
            <LinkButton href={AI.privacyHref} label={AI.privacy} />
            <Actions>
              <Button variant="outline" label={asking ? AI.asking : AI.read} disabled={asking} onPress={ask} />
            </Actions>
          </Stack>
        ) : <Small>{cantRead}</Small>
      ) : null}
      <ConfirmDialog
        visible={confirming}
        title={AI.undoTitle}
        body={ai === null ? '' : undoBody(ai)}
        confirmLabel={AI.undoConfirm}
        pendingLabel={AI.undoing}
        pending={undoing}
        onConfirm={undo}
        onCancel={() => { setConfirming(false); }}
      />
    </Panel>
  );
}

/** A done read: what TownwiseAI found, then what it added, each with its link or why not. */
function Done(props: { ai: AiRead; locationId: string; onUndo: () => void }): React.JSX.Element {
  const { ai, locationId } = props;
  const kind = kindFoundLine(ai.kind);
  const forecast = forecastLine(ai.calibration);
  const guard = guardLine(ai.notesSkipped);
  const rules = rulesSuggestedLine(ai.rulesSuggested);
  return (
    <Stack gap={theme.space[3]}>
      {kind === null ? null : <Small white>{kind}</Small>}
      {ai.summary === null || ai.summary === '' ? null : <Small>{ai.summary}</Small>}
      {ai.facts === null || ai.facts.length === 0 ? null : <Lines label={AI.found} items={ai.facts} />}
      {ai.partial ? <Small>{AI.partial}</Small> : null}
      {ai.daysCut ? <Small>{AI.daysCut}</Small> : null}
      <Small white>{AI.added}</Small>
      {ai.notes.length === 0 ? <Small>{AI.noNotes}</Small> : (
        <Stack gap={theme.space[2]}>
          <Small>{notesLine(ai.notes.length)}</Small>
          <Lines label={AI.notesList} items={ai.notes.map(noteLine)} />
          <LinkButton href={locationHref(locationId, 'notes')} label={AI.notesLink} />
        </Stack>
      )}
      {rules === null ? null : (
        <Stack gap={theme.space[2]}>
          <Small>{rules}</Small>
          <LinkButton href={locationHref(locationId, 'rules')} label={AI.rulesLink} />
        </Stack>
      )}
      {guard === null ? null : <Small>{guard}</Small>}
      <Small>{daysLine(ai)}</Small>
      {ai.uploadRef === null ? null : <LinkButton href={itemHref(locationId, ai.uploadRef)} label={AI.daysLink} />}
      <Small>{itemLine(ai)}</Small>
      {ai.itemRef === null ? null : <LinkButton href={itemHref(locationId, ai.itemRef)} label={AI.summaryLink} />}
      {forecast === null ? null : <Small>{forecast}</Small>}
      {ai.canUndo ? (
        <Actions>
          <Button variant="outline" label={AI.undo} onPress={props.onUndo} />
        </Actions>
      ) : null}
    </Stack>
  );
}

/** A list of short lines, each after a small outlined square. */
function Lines(props: { label: string; items: readonly string[] }): React.JSX.Element {
  return (
    <View role="list" aria-label={props.label} style={styles.list}>
      {props.items.map((text, index) => (
        <View key={index} role="listitem" style={styles.row}>
          <View style={styles.square} />
          <Small style={styles.text}>{text}</Small>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: theme.space[1] },
  row: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space[2] },
  square: { width: 6, height: 6, marginTop: 7, borderWidth: 1, borderColor: theme.color.line },
  text: { flex: 1, minWidth: 0 },
});
