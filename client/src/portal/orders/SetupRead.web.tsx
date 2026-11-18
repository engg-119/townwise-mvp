import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatSize } from '../files/copy';
import { DropArea } from '../onboarding/HistoryStepDrop.web';
import { Actions, Button, LinkButton } from '../ui/Button';
import { LoadingLine, Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Section } from '../ui/layout';
import { Small } from '../ui/text';
import { problemLine, proposalSummary } from './proposal';
import type { ReadSlot } from './SetupEditor';
import { heicToJpeg } from './heic.web';
import { READ_ACCEPT, READ_COPY, readingLine, readKindOf } from './setupReadWords';
import { useSetupRead } from './useSetupRead';

// Reading the ordering setup with TownwiseAI on the web (D41, P31), drawn only while the setup's `canReadWithAi` holds.
// The person drops or chooses one file, or pastes text, and presses Read: only then is it sent, once, as base64 with the
// kind its extension names (never its name) or as the text, to POST .../orders/setup/read. The answer merges into the
// unsaved draft through the sheet import's merge (proposal.ts) and the summary says what to set and check. A file over
// the caps is refused here with the cap in words; every refusal from the API is said in plain words. Cancel stops the
// request and nothing is added. An answer that comes while the editor is locked (a save running) waits for the lock to
// lift and then merges into the draft the save left, so the save never drops it. Under view-as every control is
// disabled in place, described by the read-only line, and no file input is drawn, so no client file is read into a
// staff browser. Nothing here logs or keeps the file or text. The read itself (one at a time, Cancel, the held answer) is
// useSetupRead.ts, shared with the native apps' SetupRead.tsx.

/** A file's bytes as standard base64, read in the browser. */
function base64Of(file: Blob): Promise<string> {
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
  const input = useRef<HTMLInputElement | null>(null);
  const { file, setFile, text, setText, shown, reading, choose: chooseOne, refuse, start, readText, cancel } = useSetupRead<File>(props);
  const [over, setOver] = useState(false);
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };

  function choose(files: File[]): void {
    const [chosen] = files;
    if (files.length !== 1 || chosen === undefined) {
      refuse(READ_COPY.oneFile);
      return;
    }
    const checked = readKindOf(chosen);
    if ('problem' in checked) {
      refuse(checked.problem);
      return;
    }
    chooseOne(chosen);
  }

  function readFile(): void {
    if (file === null) return;
    const checked = readKindOf(file);
    if ('problem' in checked) return;
    void start('file', async (current) => {
      let sent: Blob = file;
      if (checked.heic) {
        const converted = await heicToJpeg(file);
        // Stopped while it was drawn: what is returned is never shown, so skip the bytes.
        if (!current()) return { problem: READ_COPY.notRead };
        if ('problem' in converted) return { problem: converted.problem === 'too_large' ? READ_COPY.heicLarge : READ_COPY.heicNotRead };
        sent = converted.jpeg;
      }
      try {
        return { type: 'file', kind: checked.kind, data: await base64Of(sent) };
      } catch {
        return { problem: READ_COPY.notRead };
      }
    });
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
                <Button variant="outline" label={READ_COPY.readFile} disabled={!canChoose} {...described} onPress={readFile} />
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
        <Button variant="outline" label={READ_COPY.readText} disabled={!canChoose || text.trim() === ''} {...described} onPress={readText} />
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
