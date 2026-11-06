import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useAction } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { ChoiceGroup, type Choice } from '../upload/ChoiceGroup';
import { Actions, Button } from '../ui/Button';
import { Messages, ReadOnlyLine } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { answerQuestion, type ImportView, type QuestionView } from './api';
import { actionError, COPY, familyLine, optionLabel, questionText } from './copy';

// A question that pauses an import (storage 1.3 and 5.2, storage2 2.2): what Townwise needs to know, why, and
// what the answer does, as pressed-button choices with the suggested option already picked. "Not sure" keeps the
// file stored but not used. A ZIP's question names its table by its first header names. Under view-as the choices
// show and Continue is disabled, described by the read-only line. Onboarding's Reading screen (onboarding/HistoryStep)
// mounts it; give it `key={question.id}` so a new question starts fresh.

const READ_ONLY_ID = 'import-question-ro';

function split(question: QuestionView): { guests: Choice<string>[]; netSales: Choice<string>[] } {
  const of = (prefix: string): Choice<string>[] => question.options
    .filter((option) => option.id.startsWith(prefix))
    .map((option) => ({ value: option.id, label: optionLabel(question.kind, option) }));
  return { guests: of('guests:'), netSales: of('netSales:') };
}

function initial(question: QuestionView): { one: string; guests: string; netSales: string } {
  const suggested = question.suggested ?? '';
  if (question.kind !== 'columns') return { one: question.options.some((option) => option.id === suggested) ? suggested : '', guests: '', netSales: '' };
  const parts = suggested.split(',');
  return {
    one: suggested === 'not_sure' ? 'not_sure' : '',
    guests: parts.find((part) => part.startsWith('guests:')) ?? '',
    netSales: parts.find((part) => part.startsWith('netSales:')) ?? '',
  };
}

export function ImportQuestion(props: {
  locationId: string;
  importId: string;
  question: QuestionView;
  locationName: string;
  onAnswered: (view: ImportView) => void;
}): React.JSX.Element {
  const { question, onAnswered } = props;
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [picked, setPicked] = useState(() => initial(question));
  const [message, setMessage] = useState<string | null>(null);
  const text = questionText(question.kind, props.locationName);
  const columns = question.kind === 'columns';
  const notSure = picked.one === 'not_sure';

  // A value left unpicked is "not in this file"; at least one of the two must be a column (the server checks too).
  const guestsId = picked.guests === '' ? 'guests:none' : picked.guests;
  const netSalesId = picked.netSales === '' ? 'netSales:none' : picked.netSales;
  const choice = columns && !notSure ? `${guestsId},${netSalesId}` : picked.one;
  const complete = columns && !notSure ? !(guestsId.endsWith(':none') && netSalesId.endsWith(':none')) : picked.one !== '';

  const send = useAction(useCallback(async () => {
    setMessage(null);
    const view = await answerQuestion(api, props.locationId, props.importId, { questionId: question.id, choice });
    onAnswered(view);
  }, [api, props.locationId, props.importId, question.id, choice, onAnswered]));

  const press = (): void => {
    if (!complete) {
      setMessage(columns ? 'Choose a guests column, a net sales column, or both.' : 'Choose an answer.');
      return;
    }
    send.run();
  };

  const { guests, netSales } = split(question);
  const notSureChoice: Choice<string>[] = [{ value: 'not_sure', label: COPY.notSure }];
  return (
    <View style={styles.box}>
      <Stack>
        {question.family === null ? null : <Small>{familyLine(question.family)}</Small>}
        {question.fileName === null ? null : <Small>{question.fileName}</Small>}
        <Heading level={3}>{text.prompt}</Heading>
        <Small>{text.help}</Small>
        {columns ? (
          <>
            <ChoiceGroup legend="Guests" value={notSure ? '' : picked.guests} choices={guests} onChange={(value) => { setPicked((p) => ({ ...p, one: '', guests: value })); }} />
            <ChoiceGroup legend="Net sales" value={notSure ? '' : picked.netSales} choices={netSales} onChange={(value) => { setPicked((p) => ({ ...p, one: '', netSales: value })); }} />
            <ChoiceGroup legend="Or" value={picked.one} choices={notSureChoice} onChange={(value) => { setPicked((p) => ({ ...p, one: value })); }} />
          </>
        ) : (
          <ChoiceGroup
            legend="Your answer"
            value={picked.one}
            choices={question.options.map((option) => ({ value: option.id, label: optionLabel(question.kind, option) }))}
            onChange={(value) => { setPicked((p) => ({ ...p, one: value })); }}
          />
        )}
        {notSure ? <Small>{COPY.notSureHelp}</Small> : null}
        {readOnly ? <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} /> : null}
        {message === null ? null : <Messages live="alert" items={[message]} />}
        {send.error === null ? null : <Messages live="alert" items={[actionError(send.error)]} />}
        <Actions>
          {readOnly
            ? <Button variant="primary" label={COPY.answer} disabled describedBy={READ_ONLY_ID} />
            : <Button variant="primary" label={send.pending ? COPY.answering : COPY.answer} disabled={send.pending} onPress={press} />}
        </Actions>
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.panel, padding: theme.space[5] },
});
