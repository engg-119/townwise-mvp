import { useId, useState } from 'react';
import { View } from 'react-native';

import { theme } from '../../theme';
import { actionError } from '../files/copy';
import { usePortal } from '../PortalProvider';
import { Actions, Button, LinkButton } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { AI } from './aiCopy';
import { addText } from './api';
import { DATA, TEXT_MAX, TITLE_MAX } from './copy';

// “Paste text” on Your data (D28): a title and up to 10,000 characters kept for reference as a .txt file. The
// checks run before any request, in place; a refusal from the API (storage full, files off) shows under the form.
//
// D59 slice 4 (openspec change auto-apply-agent-reads): while TownwiseAI works on its own here (`auto`, from the list Your
// data last read), a box under the text starts checked, and a save with it checked sends `aiAuto: true`, so the server
// has TownwiseAI read the text as it reads a file added here. Unchecked, or with `auto` off, the text is only kept.

export function PasteText(props: {
  locationId: string;
  onSaved: (title: string) => void;
  onCancel: () => void;
  /** D59 slice 4: TownwiseAI reads text saved here on its own, so the box shows, checked. */
  auto?: boolean;
}): React.JSX.Element {
  const { api } = usePortal();
  const helpId = useId();
  const [read, setRead] = useState(true);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<{ title: string | null; text: string | null }>({ title: null, text: null });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const save = (): void => {
    if (pending) return;
    const next = {
      title: title.trim() === '' ? DATA.titleMissing : null,
      text: text.trim() === '' ? DATA.textMissing : text.length > TEXT_MAX ? DATA.textTooLong : null,
    };
    setProblems(next);
    if (next.title !== null || next.text !== null) return;
    setPending(true);
    setFailure(null);
    const clean = title.trim();
    addText(api, props.locationId, { title: clean, text, ...(props.auto === true && read ? { aiAuto: true as const } : {}) }).then(
      () => { setPending(false); props.onSaved(clean); },
      (error: unknown) => { setPending(false); setFailure(error); },
    );
  };

  return (
    <Stack gap={theme.space[4]}>
      <Heading level={3}>{DATA.pasteHeading}</Heading>
      <FormField
        label={DATA.titleLabel}
        helper={DATA.titleHelp}
        value={title}
        onChangeText={setTitle}
        maxLength={TITLE_MAX}
        autoComplete="off"
        messages={problems.title === null ? [] : [problems.title]}
      />
      <FormField
        label={DATA.textLabel}
        helper={DATA.textHelp}
        value={text}
        onChangeText={setText}
        multiline
        autoComplete="off"
        messages={problems.text === null ? [] : [problems.text]}
      />
      {props.auto === true ? (
        <View>
          <Checkbox label={AI.pasteOptIn} checked={read} disabled={pending} describedBy={helpId} onChange={setRead} />
          <Small nativeID={helpId}>{AI.pasteOptInHelp}</Small>
          <LinkButton href={AI.privacyHref} label={AI.privacy} />
        </View>
      ) : null}
      {failure === null ? null : <View><Messages live="alert" items={[actionError(failure)]} /></View>}
      <Actions>
        <Button variant="primary" label={pending ? DATA.saving : DATA.save} disabled={pending} onPress={save} />
        <Button variant="link" label={DATA.cancel} disabled={pending} onPress={props.onCancel} />
      </Actions>
    </Stack>
  );
}
