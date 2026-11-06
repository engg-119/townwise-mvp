import { StyleSheet, Text, View } from 'react-native';

import type { Note } from '../../portal/locations/api';
import { Button } from '../../portal/ui/Button';
import { ErrorNotice } from '../../portal/ui/feedback';
import { Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { Question, QuestionAnswer } from '../api';
import { dayText, formatCount, KIND_LABEL, rangeText, weekdayName, weekdaysText } from '../format';
import type { Answered } from '../useAgentPanel';

// A question TownwiseAI has for the person (spec P25): asked by rules over the location's own sales and
// notes, never by an estimate. A heading question, one line of what it saw, the three answers, and a line saying
// what an answer does. Once answered, the answers give way to what the answer did.

export interface QuestionCopy {
  heading: string;
  context: string;
  answers: { value: QuestionAnswer; label: string }[];
  help: string;
}

function days(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'day' : 'days'}`;
}

export function questionCopy(question: Question, locationName: string): QuestionCopy {
  if (question.kind === 'weekday') {
    const name = weekdayName(question.weekday);
    const range = rangeText(question.startDate, question.endDate);
    return {
      heading: `Are you closed on ${name}?`,
      context: `${locationName} has no sales on ${formatCount(question.missing)} of the last ${formatCount(question.weeks)} ${name}.`,
      answers: [
        { value: 'closed', label: `Yes, closed ${name}` },
        { value: 'open', label: 'No, the data is missing' },
        { value: 'not_sure', label: 'Not sure' },
      ],
      help: `Yes saves a closure note for ${name} from ${range}. Any answer stops this question.`,
    };
  }
  const one = question.startDate === question.endDate;
  return {
    heading: one ? `Were you closed on ${rangeText(question.startDate, question.endDate)}?` : `Were you closed ${rangeText(question.startDate, question.endDate)}?`,
    context: one ? 'There are no sales for this day.' : `There are no sales for these ${days(question.days)}.`,
    answers: [
      { value: 'closed', label: 'Yes, we were closed' },
      { value: 'open', label: 'No, the data is missing' },
      { value: 'not_sure', label: 'Not sure' },
    ],
    help: one
      ? 'Yes saves a closure note for that day. If the data is missing, upload that day and TownwiseAI will use it.'
      : 'Yes saves a closure note for those days. If the data is missing, upload those days and TownwiseAI will use them.',
  };
}

/** What an answer did: the note it saved, or that the question won't come back. */
export function answeredLine(answered: Answered): string {
  if (answered.answer === 'closed' && answered.note !== null) return savedNoteLine(answered.note);
  if (answered.answer === 'closed') return 'Saved. TownwiseAI treats those days as closed.';
  return 'Got it. TownwiseAI won’t ask about these days again.';
}

function savedNoteLine(note: Note): string {
  const one = note.startDate === note.endDate;
  const dates = one ? dayText(note.startDate) : rangeText(note.startDate, note.endDate);
  const weekdays = weekdaysText(note.weekdays);
  const which = weekdays === null ? dates : `${weekdays.replace(/ only$/, '')}, ${dates}`;
  return `Saved a note: ${KIND_LABEL[note.kind]}, ${which}. TownwiseAI treats ${one && weekdays === null ? 'that day' : 'those days'} as closed.`;
}

export function QuestionCard(props: {
  question: Question;
  locationName: string;
  answered: Answered | undefined;
  answering: boolean;
  /** Another question's answer is being sent. */
  busy: boolean;
  error: string | undefined;
  readOnlyId: string | null;
  onAnswer: (answer: QuestionAnswer) => void;
}): React.JSX.Element {
  const copy = questionCopy(props.question, props.locationName);
  const helpId = `question-help-${props.question.id}`;
  const off = props.readOnlyId !== null || props.answering || props.busy;
  return (
    <View style={styles.card}>
      <Heading level={3}>{copy.heading}</Heading>
      <Text style={styles.context}>{copy.context}</Text>
      {props.answered === undefined ? (
        <>
          <View role="group" aria-label={copy.heading} style={styles.answers}>
            {copy.answers.map((answer) => (
              <Button
                key={answer.value}
                variant="outline"
                label={answer.label}
                disabled={off}
                describedBy={[props.readOnlyId, helpId].filter((id): id is string => id !== null).join(' ')}
                onPress={() => { props.onAnswer(answer.value); }}
              />
            ))}
          </View>
          <Text nativeID={helpId} style={styles.help}>{props.answering ? 'Saving your answer…' : copy.help}</Text>
        </>
      ) : (
        <Text role="status" style={styles.done}>{answeredLine(props.answered)}</Text>
      )}
      {props.error === undefined ? null : <ErrorNotice message={props.error} />}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  context: { ...theme.type.small, color: c.text2 },
  answers: { gap: theme.space[2], alignItems: 'flex-start' },
  help: { ...theme.type.small, color: c.text3 },
  done: { ...theme.type.small, color: c.white },
});
