import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatSize } from '../files/copy';
import { Actions, Button, LinkButton } from '../ui/Button';
import { LoadingLine, Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Section } from '../ui/layout';
import { Small } from '../ui/text';
import { problemLine, proposalSummary } from './proposal';
import type { ReadSlot } from './SetupEditor';
import { READ_COPY, readingLine, readKindOf } from './setupReadWords';
import { useSetupRead } from './useSetupRead';

// Reading the ordering setup with TownwiseAI in the iOS and Android apps (D41, P31), drawn only while the setup's
// `canReadWithAi` holds: the web's section (SetupRead.web.tsx) without the drop zone, on the same read (useSetupRead.ts).
// Choose a file opens the system picker, which copies the file into the app's cache; it is checked by its name and size
// before anything is read, and a HEIC photo is refused, since the converter is web only. Pressing Read reads the copy
// as base64 and sends it once with the kind its extension names (never its name); the copy is deleted once its bytes
// are read, whether or not that worked, and whenever the file is removed, replaced or the page closes. Under view-as
// every control is disabled in place, described by the read-only line, and the picker never opens, so no client file
// is read onto a staff phone. Nothing here logs the file's name, its location or what it says.

/** What the system picker is asked to show; the name and size are still checked (readKindOf). */
const PICK_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/*',
  'image/*',
  'application/json',
  'application/rtf',
  'application/xml',
];

interface Picked {
  readonly name: string;
  readonly size: number;
  /** The picker's copy in the app's cache. */
  readonly uri: string;
}

/** Deletes the picker's copy; one already gone is fine. */
function discard(uri: string): void {
  try {
    new File(uri).delete();
  } catch {
    // Already deleted, or never copied.
  }
}

export function SetupRead(props: ReadSlot): React.JSX.Element {
  const { file, setFile, text, setText, shown, reading, choose, refuse, start, readText, cancel } = useSetupRead<Picked>(props);
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };
  const canChoose = !props.locked && !reading;

  // The copy goes when the file is removed, replaced, read or sent, or the page closes.
  useEffect(() => {
    if (file === null) return undefined;
    const { uri } = file;
    return () => { discard(uri); };
  }, [file]);

  async function pick(): Promise<void> {
    if (!canChoose) return;
    let result: Awaited<ReturnType<typeof getDocumentAsync>>;
    try {
      result = await getDocumentAsync({ multiple: false, copyToCacheDirectory: true, type: PICK_TYPES });
    } catch {
      refuse(READ_COPY.notReadApp);
      return;
    }
    if (result.canceled) return;
    const [asset] = result.assets;
    if (result.assets.length !== 1 || asset === undefined) {
      for (const each of result.assets) discard(each.uri);
      refuse(READ_COPY.oneFile);
      return;
    }
    const picked: Picked = { name: asset.name, size: asset.size ?? new File(asset.uri).size, uri: asset.uri };
    const checked = readKindOf(picked);
    const problem = 'problem' in checked ? checked.problem : checked.heic ? READ_COPY.heicApp : null;
    if (problem !== null) {
      discard(picked.uri);
      refuse(problem);
      return;
    }
    choose(picked);
  }

  function readFile(): void {
    if (file === null) return;
    const checked = readKindOf(file);
    if ('problem' in checked || checked.heic) return;
    const picked = file;
    void start('file', async () => {
      try {
        return { type: 'file', kind: checked.kind, data: await new File(picked.uri).base64() };
      } catch {
        return { problem: READ_COPY.notReadApp };
      } finally {
        // Its bytes are read (or can't be): the copy goes, so another try chooses the file again.
        discard(picked.uri);
        setFile(null);
      }
    });
  }

  return (
    <Section title={READ_COPY.heading}>
      <Small>{READ_COPY.leadApp}</Small>
      <Small>{READ_COPY.registerApp}</Small>
      <LinkButton href={READ_COPY.privacyHref} label={READ_COPY.privacy} />
      <View style={styles.zone}>
        <Small white>{READ_COPY.pick}</Small>
        {file === null ? null : <Small white>{`Chosen: ${file.name}, ${formatSize(file.size)}.`}</Small>}
        <Actions>
          <Button variant="outline" label={READ_COPY.choose} disabled={!canChoose} {...described} onPress={() => { void pick(); }} />
          {file === null ? null : (
            <>
              <Button variant="outline" label={READ_COPY.readFile} disabled={!canChoose} {...described} onPress={readFile} />
              <Button variant="link" label={READ_COPY.remove} disabled={!canChoose} {...described} onPress={() => { setFile(null); }} />
            </>
          )}
        </Actions>
      </View>
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
  zone: { gap: theme.space[3], padding: theme.space[6], borderWidth: 1, borderColor: c.line, backgroundColor: c.panel },
});
