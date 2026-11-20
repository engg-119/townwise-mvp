import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { queueLine } from '../files/copy';
import { useUploadQueue } from '../files/uploadQueue';
import { FilePicker } from '../onboarding/HistoryStepDrop';
import { usePortal } from '../PortalProvider';
import { LinkButton } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Mono, Small } from '../ui/text';
import { useLoad } from '../hooks';
import { AI, cantReadLine, optInLine, type OptInState } from './aiCopy';
import { getItem, isCalendarFileName, readWithAi, type DataItem } from './api';
import { DATA } from './copy';
import { CalendarImport } from './item/CalendarImport';
import { CALENDAR_IMPORT } from './item/copy';

// “Add a file” on Your data (D28): any kind of file, up to the stored-file cap, kept as it is for reference. It
// reuses the history drop step's queue with the purpose `reference`: the same chunks, caps and retries. Nothing here
// opens or reads a file. Mounted only on web with stored files on; the queue is stopped when the page closes.
//
// The TownwiseAI opt-in (D34, spec 11A.9), off by default: while it is checked, each file that finishes uploading is
// sent to TownwiseAI to read (POST .../data/f_<id>/ai) once, unless TownwiseAI can't read its kind; a file that
// finished while it was unchecked is never sent. How each one went shows beside it; a refusal never undoes the upload. There is
// no cheap way to know beforehand whether reading with TownwiseAI is on, so the box shows with stored files on and
// hides once a request answers 503 ai_unavailable, for as long as the page is open.
//
// D59 (openspec change auto-apply-agent-reads): while TownwiseAI works on its own here (`auto`, from the last list that
// answered), the box starts checked and nothing is pressed: the server reads each file once it is stored. The box is read
// as each upload completes, and only a checked box sends `aiAuto: true` (files/uploadQueue.ts), so a file that finishes
// while it is unchecked is kept from TownwiseAI. Once the person changes the box, their choice stays until the page
// closes.
//
// UI review 2026-11-19: a calendar file (an .ics or .ical file, kept as `other`) is imported as a calendar once stored
// (D60), never sent to TownwiseAI, checked or not. Beside it, once it finishes, its item is read and the line says what
// the import did, as its page does (item/CalendarImport.tsx): added with the calendar's link, or why not with Try again
// where a retry may mend it; never that TownwiseAI can't read it.

/** A finished file the person let TownwiseAI read: its stored file's id and how asking went. */
interface Asked { fileId: string; ai: OptInState }

export function AddFile(props: {
  locationId: string;
  enabled: boolean;
  describedBy?: string;
  /** A file finished uploading: the list reloads. */
  onStored: () => void;
  /** TownwiseAI took a finished file to read (or was already reading it): the list reloads, so its row says so. */
  onAsked?: () => void;
  /** D59: TownwiseAI reads each file added here on its own, so the box starts checked and nothing is pressed. */
  auto?: boolean;
}): React.JSX.Element {
  const { api } = usePortal();
  const auto = props.auto === true;
  // The person's choice, once they changed the box; until then it follows `auto` (checked while it works on its own).
  const [chosen, setChosen] = useState<boolean | null>(null);
  const optIn = chosen ?? auto;
  const optInRef = useRef(optIn);
  useEffect(() => { optInRef.current = optIn; }, [optIn]);
  // Stable, so the queue (and the uploads in it) never restarts when the box or `auto` changes.
  const aiAuto = useCallback(() => optInRef.current, []);
  const queue = useUploadQueue(props.locationId, { purpose: 'reference', aiAuto });
  const { onStored, onAsked, locationId } = props;
  const finished = queue.items.filter((item) => item.state === 'done').length;
  // Told once per finished file, whatever `onStored` is by then.
  const told = useRef(0);
  useEffect(() => {
    if (finished > told.current) onStored();
    told.current = finished;
  }, [finished, onStored]);

  const [aiOff, setAiOff] = useState(false);
  // Each finished file, by its queue key, once looked at: null when it finished with the box unchecked (never sent).
  const [asked, setAsked] = useState<Readonly<Record<string, Asked | null>>>({});
  const fresh = queue.items.filter((item) => item.state === 'done' && item.fileId !== null && !Object.hasOwn(asked, item.key));
  if (fresh.length > 0) {
    setAsked((current) => {
      const next = { ...current };
      for (const item of fresh) {
        if (!optIn || aiOff || item.fileId === null || isCalendarDone(item)) {
          next[item.key] = null;
          continue;
        }
        const why = item.file === null ? null : cantReadLine({ kind: item.file.kind, name: item.file.name ?? item.name });
        // D59: the server reads it on its own; nothing is pressed.
        next[item.key] = { fileId: item.fileId, ai: why !== null ? { state: 'not_read', why } : auto ? { state: 'auto' } : { state: 'asking' } };
      }
      return next;
    });
  }
  // Each file marked `asking` is sent once.
  const sent = useRef(new Set<string>());
  useEffect(() => {
    const mark = (key: string, fileId: string, ai: OptInState): void => { setAsked((current) => ({ ...current, [key]: { fileId, ai } })); };
    for (const [key, entry] of Object.entries(asked)) {
      if (entry?.ai.state !== 'asking' || sent.current.has(key)) continue;
      sent.current.add(key);
      const { fileId } = entry;
      readWithAi(api, locationId, `f_${fileId}`).then(
        () => { mark(key, fileId, { state: 'asked' }); },
        (error: unknown) => {
          if (hasCode(error, 409, 'ai_read_running')) {
            mark(key, fileId, { state: 'asked' });
            return;
          }
          if (hasCode(error, 503, 'ai_unavailable')) {
            setAiOff(true);
            setChosen(false);
          }
          mark(key, fileId, { state: 'refused', error });
        },
      );
    }
  }, [asked, api, locationId]);
  // Told once per file TownwiseAI took, whatever `onAsked` is by then: `onStored` reloaded the list before it answered.
  const taken = Object.values(asked).filter((entry) => entry?.ai.state === 'asked').length;
  const toldTaken = useRef(0);
  useEffect(() => {
    if (taken > toldTaken.current) onAsked?.();
    toldTaken.current = taken;
  }, [taken, onAsked]);

  const helpId = `${useId().replace(/:/g, '')}-ai-help`;
  const shown = queue.items.filter((item) => (
    item.state !== 'cancelled' && (item.state !== 'done' || (asked[item.key] ?? null) !== null || isCalendarDone(item))
  ));
  return (
    <View style={styles.box}>
      <FilePicker
        enabled={props.enabled}
        label={DATA.addFile}
        onFiles={queue.add}
        {...(props.describedBy === undefined ? {} : { describedBy: props.describedBy })}
      />
      {aiOff ? null : (
        <View style={styles.optIn}>
          <Checkbox
            label={AI.optIn}
            checked={optIn}
            disabled={!props.enabled}
            describedBy={[helpId, props.describedBy].filter((id) => id !== undefined).join(' ')}
            onChange={setChosen}
          />
          <Small nativeID={helpId}>{auto ? AI.optInHelpAuto : AI.optInHelp}</Small>
          <LinkButton href={AI.privacyHref} label={AI.privacy} />
        </View>
      )}
      {shown.length === 0 ? null : (
        <View role="list" aria-label="Files being added" style={styles.queue}>
          {shown.map((item) => {
            const ai = asked[item.key]?.ai;
            return (
              <View key={item.key} role="listitem" style={styles.item}>
                <Mono tone="white">{item.name}</Mono>
                {item.state === 'done' && item.fileId !== null && isCalendarDone(item)
                  ? <CalendarFileLine locationId={locationId} fileId={item.fileId} />
                  : <Small>{item.state === 'done' && ai !== undefined ? optInLine(ai) : queueLine(item)}</Small>}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** A finished file the API keeps as a calendar file: imported as a calendar, never sent to TownwiseAI. */
function isCalendarDone(item: { state: string; file: { kind: string; name: string | null } | null; name: string }): boolean {
  return item.state === 'done' && item.file?.kind === 'other' && isCalendarFileName(item.file.name ?? item.name);
}

/** What importing a calendar file just added did, from its item (D60), as its page says it. */
function CalendarFileLine(props: { locationId: string; fileId: string }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, fileId } = props;
  const { state } = useLoad(useCallback(() => getItem(api, locationId, `f_${fileId}`), [api, locationId, fileId]));
  // The item Try again answered, once pressed.
  const [after, setAfter] = useState<DataItem | null>(null);
  const item = after ?? (state.status === 'ready' ? state.data : null);
  if (item === null) return <Small>{state.status === 'failed' ? CALENDAR_IMPORT.unknown : CALENDAR_IMPORT.checking}</Small>;
  if ((item.calendar ?? null) === null) return <Small>{CALENDAR_IMPORT.unknown}</Small>;
  return <CalendarImport item={item} readOnlyId={null} showItem={setAfter} />;
}

const styles = StyleSheet.create({
  box: { gap: theme.space[3], alignItems: 'flex-start' },
  optIn: { gap: theme.space[1], maxWidth: 560 },
  queue: { gap: theme.space[2], alignSelf: 'stretch' },
  item: { gap: 2, minWidth: 0 },
});
