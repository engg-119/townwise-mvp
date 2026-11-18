import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatSize } from '../files/copy';
import { DropArea } from '../onboarding/HistoryStepDrop.web';
import { usePortal } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { LoadingLine, Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Section } from '../ui/layout';
import { Small } from '../ui/text';
import { readSetupWithAi, type SetupRead as SetupReadAnswer, type SetupReadSource } from './api';
import { importProposal, problemLine, proposalSummary, type ProposalImport, type ReadFrom } from './proposal';
import type { ReadSlot } from './SetupEditor';
import { onlyLinks, READ_ACCEPT, READ_COPY, readError, readingLine, readKindOf } from './setupReadWords';

// Reading the ordering setup with TownwiseAI on the web (D41, P31), drawn only while the setup's `canReadWithAi` holds.
// The person drops or chooses one file, or pastes text, and presses Read: only then is it sent, once, as base64 with the
// kind its extension names (never its name) or as the text, to POST .../orders/setup/read. The answer merges into the
// unsaved draft through the sheet import's merge (proposal.ts) and the summary says what to set and check. A file over
// the caps is refused here with the cap in words; every refusal from the API is said in plain words. Cancel stops the
// request and nothing is added. An answer that comes while the editor is locked (a save running) waits for the lock to
// lift and then merges into the draft the save left, so the save never drops it. Under view-as every control is
// disabled in place, described by the read-only line, and no file input is drawn, so no client file is read into a
// staff browser. Nothing here logs or keeps the file or text.

type Shown =
  | { kind: 'idle' }
  | { kind: 'refused'; message: string }
  | { kind: 'reading'; from: ReadFrom }
  | { kind: 'done'; from: ReadFrom; result: ProposalImport }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' };

/** A file's bytes as standard base64, read in the browser. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsDataURL(file);
  });
}

export function SetupRead(props: ReadSlot): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const input = useRef<HTMLInputElement | null>(null);
  const latest = useRef(props.draft);
  const run = useRef(0);
  const stop = useRef<AbortController | null>(null);
  const locked = useRef(props.locked);
  /** An answer that came while the editor was locked, merged once it isn't. */
  const held = useRef<{ answer: SetupReadAnswer; from: ReadFrom } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };
  const reading = shown.kind === 'reading';

  useEffect(() => { latest.current = props.draft; }, [props.draft]);
  // After every render, so it sees the draft a save left (the effect above runs first).
  useEffect(() => {
    locked.current = props.locked;
    const waiting = held.current;
    if (props.locked || waiting === null) return;
    held.current = null;
    land(waiting.answer, waiting.from);
  });
  useEffect(() => () => {
    run.current += 1;
    stop.current?.abort();
  }, []);

  function choose(files: File[]): void {
    const [chosen] = files;
    if (files.length !== 1 || chosen === undefined) {
      setShown({ kind: 'refused', message: READ_COPY.oneFile });
      return;
    }
    const checked = readKindOf(chosen);
    if ('problem' in checked) {
      setShown({ kind: 'refused', message: checked.problem });
      return;
    }
    setFile(chosen);
    setShown({ kind: 'idle' });
  }

  function land(answer: SetupReadAnswer, from: ReadFrom): void {
    const result = importProposal(answer, latest.current, from);
    props.apply(result);
    if (from === 'file') setFile(null);
    else setText('');
    setShown({ kind: 'done', from, result });
  }

  async function read(from: ReadFrom): Promise<void> {
    if (props.locked || reading) return;
    const checked = from === 'file' && file !== null ? readKindOf(file) : null;
    if (from === 'file' && (file === null || checked === null || 'problem' in checked)) return;
    if (from === 'text' && onlyLinks(text)) {
      setShown({ kind: 'refused', message: READ_COPY.link });
      return;
    }
    run.current += 1;
    const mine = run.current;
    const controller = new AbortController();
    stop.current = controller;
    setShown({ kind: 'reading', from });
    try {
      let source: SetupReadSource;
      if (from === 'file') {
        if (file === null || checked === null || 'problem' in checked) return;
        let data: string;
        try {
          data = await base64Of(file);
        } catch {
          if (run.current === mine) setShown({ kind: 'failed', message: READ_COPY.notRead });
          return;
        }
        if (run.current !== mine) return;
        source = { type: 'file', kind: checked.kind, data };
      } else {
        source = { type: 'text', text };
      }
      const answer = await readSetupWithAi(api, location.id, source, controller.signal);
      if (run.current !== mine) return;
      if (locked.current) held.current = { answer, from };
      else land(answer, from);
    } catch (error) {
      if (run.current === mine) setShown({ kind: 'failed', message: readError(error) });
    } finally {
      if (stop.current === controller) stop.current = null;
    }
  }

  function cancel(): void {
    run.current += 1;
    held.current = null;
    stop.current?.abort();
    stop.current = null;
    setShown({ kind: 'stopped' });
  }

  const canChoose = !props.locked && !reading;
  return (
    <Section title={READ_COPY.heading}>
      <Small>{READ_COPY.lead}</Small>
      <Small>{READ_COPY.register}</Small>
      <LinkButton href={READ_COPY.privacyHref} label={READ_COPY.privacy} />
      <DropArea enabled={canChoose} onFiles={choose} onOver={(count) => { setOver(count !== null); }}>
        <View style={[styles.zone, over && canChoose ? styles.zoneOver : null]}>
          <Small white>{over && canChoose ? READ_COPY.dropOver : READ_COPY.drop}</Small>
          {props.locked ? null : (
            <input
              ref={input}
              type="file"
              accept={READ_ACCEPT}
              tabIndex={-1}
              aria-hidden="true"
              data-testid="setup-read-file"
              style={{ display: 'none' }}
              onChange={(event) => {
                const chosen = Array.from(event.currentTarget.files ?? []);
                // Cleared so the same file can be chosen again.
                event.currentTarget.value = '';
                if (chosen.length > 0) choose(chosen);
              }}
            />
          )}
          {file === null ? null : <Small white>{`Chosen: ${file.name}, ${formatSize(file.size)}.`}</Small>}
          <Actions>
            <Button variant="outline" label={READ_COPY.choose} disabled={!canChoose} {...described} onPress={() => { input.current?.click(); }} />
            {file === null ? null : (
              <>
                <Button variant="outline" label={READ_COPY.readFile} disabled={!canChoose} {...described} onPress={() => { void read('file'); }} />
                <Button variant="link" label={READ_COPY.remove} disabled={!canChoose} {...described} onPress={() => { setFile(null); }} />
              </>
            )}
          </Actions>
        </View>
      </DropArea>
      <FormField
        label={READ_COPY.pasteLabel}
        helper={READ_COPY.pasteHelp}
        value={text}
        onChangeText={setText}
        multiline
        autoComplete="off"
        readOnly={props.locked}
        {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })}
      />
      <Actions>
        <Button variant="outline" label={READ_COPY.readText} disabled={!canChoose || text.trim() === ''} {...described} onPress={() => { void read('text'); }} />
      </Actions>
      {shown.kind === 'reading' ? (
        <View style={styles.stack}>
          <LoadingLine text={readingLine(shown.from)} minHeight={44} />
          <Actions>
            <Button variant="outline" label={READ_COPY.cancel} onPress={cancel} />
          </Actions>
        </View>
      ) : null}
      {shown.kind === 'refused' || shown.kind === 'failed' ? <Messages live="alert" items={[shown.message]} /> : null}
      {shown.kind === 'stopped' ? <Messages live="status" items={[READ_COPY.stopped]} /> : null}
      {shown.kind === 'done' ? (
        <View style={styles.stack}>
          <Messages live="status" items={proposalSummary(shown.result, shown.from)} />
          {shown.result.problems.length === 0 ? null : <Messages items={shown.result.problems.map(problemLine)} />}
        </View>
      ) : null}
    </Section>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  stack: { gap: theme.space[3] },
  zone: { gap: theme.space[3], padding: theme.space[6], borderWidth: 1, borderStyle: 'dashed', borderColor: c.line, backgroundColor: c.panel },
  zoneOver: { borderStyle: 'solid', borderColor: c.white, backgroundColor: c.raised },
});
