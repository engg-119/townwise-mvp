import { useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { trainedOnWords, type EstimatesAbout } from '../../portal/estimates/api';
import { formatDate } from '../../portal/format';
import type { LoadState } from '../../portal/hooks';
import { Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine, StatusTag } from '../../portal/ui/feedback';
import { Eyebrow, Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { ActivityItem, Budget } from '../api';
import { formatCount, KIND_LABEL, rangeText, weekdayName } from '../format';
import { readsLine, type ToolContext } from '../tools';
import type { AgentPanelState } from '../useAgentPanel';
import { ModelCardSheet } from './ModelCardSheet';
import { QuestionCard } from './QuestionCard';

// The side panel (spec P25): Questions for you, What it's been doing, this month's budget, and How TownwiseAI
// works. Every activity item is a real, dated event the server read from the location's own records; a kind this
// client doesn't know shows as nothing. On desktop the four sit in the side column; below 1024px the page shows
// Questions and Activity under its switch, each section on its own. How TownwiseAI works says whether Townwise has
// a forecast for the location from GET .../estimates/about (F10), and opens the model card in a sheet.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun, Nov 15", in the viewer's time zone. */
function whenText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${WEEKDAYS[date.getDay()] ?? ''}, ${SHORT_MONTHS[date.getMonth()] ?? ''} ${String(date.getDate())}`;
}

/** What a question id names: "Dec 24 to Dec 26, 2026", or "Mondays". Ids hold dates and a weekday number only. */
function questionSubject(questionId: string): string | null {
  const gap = /^gap_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(questionId);
  if (gap?.[1] !== undefined && gap[2] !== undefined) return rangeText(gap[1], gap[2]);
  const weekday = /^weekday_([0-6])_/.exec(questionId);
  if (weekday?.[1] !== undefined) return weekdayName(Number(weekday[1]));
  return null;
}

export function activityLine(item: ActivityItem): string {
  switch (item.kind) {
    case 'upload_applied':
      return `Read your upload for ${rangeText(item.firstDate, item.lastDate)}, ${formatCount(item.dayCount)} ${item.dayCount === 1 ? 'day' : 'days'}.`;
    case 'note_saved': {
      const what = `${KIND_LABEL[item.noteKind]}, ${rangeText(item.startDate, item.endDate)}`;
      return item.via === 'chat' ? `Saved a note you approved: ${what}.` : `Saved a note from your answer: ${what}.`;
    }
    case 'question_answered': {
      const subject = questionSubject(item.questionId);
      if (subject === null) return item.answer === 'open' ? 'You said the data is missing.' : 'You weren’t sure about a question.';
      return item.answer === 'open' ? `You said the data is missing for ${subject}.` : `You weren’t sure about ${subject}.`;
    }
    // F3: a stored file Townwise read. Never its name: the files list shows that, and this panel is read under view-as.
    case 'file_processed':
      return `Read your file for ${rangeText(item.firstDate, item.lastDate)}, ${formatCount(item.dayCount)} ${item.dayCount === 1 ? 'day' : 'days'}.`;
  }
}

export function QuestionsSection(props: {
  panel: AgentPanelState;
  locationName: string;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { panel } = props;
  const { state } = panel;
  let body: React.ReactNode;
  if (state.status === 'loading') body = <LoadingLine text="Loading questions" minHeight={80} />;
  else if (state.status === 'failed') body = <ErrorNotice message="Couldn’t load TownwiseAI’s questions." onRetry={panel.reload} />;
  else if (state.data.questions.length === 0) body = <Text style={styles.muted}>No questions right now.</Text>;
  else {
    body = state.data.questions.map((question) => (
      <QuestionCard
        key={question.id}
        question={question}
        locationName={props.locationName}
        answered={panel.answered[question.id]}
        answering={panel.answering === question.id}
        busy={panel.answering !== null && panel.answering !== question.id}
        error={panel.errors[question.id]}
        readOnlyId={props.readOnlyId}
        onAnswer={(answer) => { panel.answer(question.id, answer); }}
      />
    ));
  }
  const open = state.status === 'ready' ? state.data.questions.filter((question) => panel.answered[question.id] === undefined).length : null;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        {open === null ? null : <Eyebrow>{`${formatCount(open)} open`}</Eyebrow>}
        <Heading>Questions for you</Heading>
      </View>
      {body}
      <View style={styles.planned}>
        <StatusTag label="Planned" kind="planned" />
        <Text style={styles.muted}>TownwiseAI’s own research (unusual nights, town events it finds) is planned.</Text>
      </View>
    </View>
  );
}

export function ActivitySection(props: { panel: AgentPanelState }): React.JSX.Element {
  const { state } = props.panel;
  let body: React.ReactNode;
  if (state.status === 'loading') body = <LoadingLine text="Loading activity" minHeight={80} />;
  else if (state.status === 'failed') body = <ErrorNotice message="Couldn’t load what TownwiseAI has been doing." onRetry={props.panel.reload} />;
  else if (state.data.activity.length === 0) body = <Text style={styles.muted}>Nothing yet. Upload sales or save a note and it shows here.</Text>;
  else {
    body = (
      <View style={styles.list}>
        {state.data.activity.map((item, index) => {
          const when = whenText(item.at);
          return (
            <View key={`${item.at}-${String(index)}`} style={styles.item}>
              <Text style={styles.when}>{when}</Text>
              <Text style={styles.itemText}>{activityLine(item)}</Text>
            </View>
          );
        })}
      </View>
    );
  }
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Eyebrow>Newest first</Eyebrow>
        <Heading>What it’s been doing</Heading>
      </View>
      {body}
    </View>
  );
}

/** "November: 18% used. Resets Dec 1." Percent, not dollars. */
export function budgetLines(budget: Budget): { line: string; warning: string | null } {
  const [year, month] = budget.month.split('-').map(Number);
  const index = (month ?? 1) - 1;
  const name = MONTHS[index] ?? budget.month;
  const next = SHORT_MONTHS[(index + 1) % 12] ?? '';
  const percent = budget.exhausted ? 100 : budget.limitUsd <= 0 ? 0 : Math.min(100, Math.round((budget.usedUsd / budget.limitUsd) * 100));
  const nextYear = index === 11 && year !== undefined ? `, ${String(year + 1)}` : '';
  if (budget.exhausted) return { line: `${name}: all used. Resets ${next} 1${nextYear}.`, warning: null };
  return {
    line: `${name}: ${String(percent)}% used. Resets ${next} 1${nextYear}.`,
    warning: percent >= 80 ? `Most of ${name}’s budget is used. TownwiseAI pauses when it runs out.` : null,
  };
}

export function BudgetSection(props: { budget: Budget | null }): React.JSX.Element | null {
  if (props.budget === null) return null;
  const { line, warning } = budgetLines(props.budget);
  return (
    <View style={styles.section}>
      <Heading>This month’s budget</Heading>
      <Text style={styles.body}>{line}</Text>
      {warning === null ? null : <Text style={styles.body}>{warning}</Text>}
    </View>
  );
}

/**
 * F10: How TownwiseAI works' forecast line, from GET .../estimates/about, so it says so by itself once staff publish a
 * forecast for the location. Null while that read is loading.
 */
export function forecastLine(about: LoadState<EstimatesAbout>, ctx: ToolContext): string | null {
  if (about.status === 'loading') return null;
  if (about.status === 'failed') return 'Couldn’t check whether Townwise has a forecast for this location.';
  const { run } = about.data.forecast;
  if (run === null) return `Townwise has no forecast for this location yet, so TownwiseAI answers from ${readsLine({ ...ctx, hasForecast: false })}.`;
  return `TownwiseAI also reads the forecast Townwise published: ${run.model.label}, trained on ${trainedOnWords(run.trainingSource)} from ${formatDate(run.trainedFrom)} to ${formatDate(run.dataThrough)}, made ${formatDate(run.madeAt)}.`;
}

export function HowItWorks(props: {
  ctx: ToolContext;
  locationId: string;
  about: LoadState<EstimatesAbout>;
  onRetryAbout: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState(false);
  const forecast = forecastLine(props.about, props.ctx);
  return (
    <View style={styles.section}>
      <Pressable
        role="button"
        accessibilityLabel="How TownwiseAI works"
        aria-expanded={open}
        onPress={() => { setOpen((value) => !value); }}
        style={styles.disclosure}
      >
        <View style={styles.box}><Text style={styles.glyph}>{open ? '−' : '+'}</Text></View>
        <Text style={styles.disclosureText}>How TownwiseAI works</Text>
      </Pressable>
      {open ? (
        <View style={styles.list}>
          <Text style={styles.body}>{`It reads ${readsLine(props.ctx)}, and shows you each thing it reads.`}</Text>
          <Text style={styles.body}>It can’t see the weather, your staffing, your bookings unless you add them as notes, or guest names.</Text>
          <Text style={styles.body}>It suggests notes; it never saves one without you.</Text>
          {forecast === null ? null : <Text style={styles.body}>{forecast}</Text>}
          {props.about.status === 'failed' ? <Button variant="link" label="Try again" onPress={props.onRetryAbout} /> : null}
          <Button variant="link" label="How Townwise estimates" onPress={() => { setCard(true); }} />
          <Text style={styles.body}>
            Your messages and the data it reads go to Anthropic, which provides the AI model.{' '}
            <Link href="/privacy" style={styles.link}>Privacy</Link>
          </Text>
        </View>
      ) : null}
      <ModelCardSheet visible={card} locationId={props.locationId} onClose={() => { setCard(false); }} />
    </View>
  );
}

export function AgentSidePanel(props: {
  panel: AgentPanelState;
  budget: Budget | null;
  ctx: ToolContext;
  locationId: string;
  locationName: string;
  readOnlyId: string | null;
  about: LoadState<EstimatesAbout>;
  onRetryAbout: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.panel}>
      <QuestionsSection panel={props.panel} locationName={props.locationName} readOnlyId={props.readOnlyId} />
      <ActivitySection panel={props.panel} />
      <BudgetSection budget={props.budget} />
      <HowItWorks ctx={props.ctx} locationId={props.locationId} about={props.about} onRetryAbout={props.onRetryAbout} />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  panel: { gap: theme.space[8] },
  section: { gap: theme.space[3] },
  head: { gap: theme.space[1] },
  muted: { ...theme.type.small, color: c.text3, flexShrink: 1 },
  planned: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[2], flexWrap: 'wrap', rowGap: theme.space[1] },
  list: { gap: theme.space[3] },
  item: { gap: 2 },
  when: { ...theme.type.mono, color: c.text3 },
  itemText: { ...theme.type.small, color: c.white },
  body: { ...theme.type.small, color: c.text2 },
  link: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  disclosure: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, alignSelf: 'flex-start' },
  box: { width: 20, height: 20, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  glyph: { ...theme.type.ui, color: c.white, lineHeight: 18 },
  disclosureText: { ...theme.type.ui, color: c.white },
});
