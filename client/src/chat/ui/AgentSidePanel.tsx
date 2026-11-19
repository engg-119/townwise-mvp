import { useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { trainedOnWords, type EstimatesAbout } from '../../portal/estimates/api';
import { formatDate } from '../../portal/format';
import type { LoadState } from '../../portal/hooks';
import { locationHref } from '../../portal/routing';
import { RuleSuggestionCard } from '../../portal/rules/RuleSuggestionCard';
import { SUGGESTED_COPY, toDecideLine } from '../../portal/rules/suggestionWords';
import { Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine, StatusTag } from '../../portal/ui/feedback';
import { Eyebrow, Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import { changeLine, savesLine } from '../agentChanges';
import type { ActivityItem, Budget } from '../api';
import { dayText, formatCount, KIND_LABEL, rangeText, weekdayName } from '../format';
import { readsLine, type ToolContext } from '../tools';
import { openQuestions, openRuleSuggestions, type AgentPanelState, type SendToChat } from '../useAgentPanel';
import { ActivityChange, AgentAutoSwitch, NoteSuggestionsSection, WaitingLine } from './AgentChanges';
import { ModelCardSheet } from './ModelCardSheet';
import { QuestionCard, type QuestionChat } from './QuestionCard';
import { SuggestionsSection } from './SuggestionCard';

// The side panel (spec P25): Suggested rules (D46: suggested closure rules from files and the sales history, shown only
// while there are some, and in the column beside the landing too), Questions for you, Suggested for the next 3 months (TownwiseAI's weekly suggestions,
// openspec change weekly-forecast-suggestions, shown in the column beside the landing too, which lists only questions),
// What it's been doing, this month's budget, and How TownwiseAI works. At 640px and below an empty conversation's landing lists the questions under its chips, so the row leaves Questions
// for you out and they aren't drawn twice; from 641px the column holds them (owner, 2026-11-18). Every activity item is a real, dated event the server read from the location's own records; a kind this
// client doesn't know shows as nothing. The page shows the four as Questions and activity on the new chat page only: a column
// beside the landing from 641px, a row under its chips that opens in place at 640px and below. How TownwiseAI works says whether Townwise has a forecast for the location from
// GET .../estimates/about (F10), and opens the model card in a sheet.
// D59 (openspec change auto-apply-agent-reads): a change TownwiseAI saved on its own is an activity line with Undo,
// above the activity a line counts what it wasn't sure of and links to the log of every change, the switch for working
// on its own sits after the weekly suggestions' switches, the events a file read wasn't sure of wait under it in "Not
// sure from your files", and How TownwiseAI works says it saves what it's sure of while that switch is on.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun, Nov 15", in the viewer's time zone. */
function whenText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${WEEKDAYS[date.getDay()] ?? ''}, ${SHORT_MONTHS[date.getMonth()] ?? ''} ${String(date.getDate())}`;
}

/**
 * What a question id names: "Dec 24 to Dec 26, 2026", "Sat, May 23, 2026" or "Mondays". Ids hold dates and a weekday
 * number only.
 */
function questionSubject(questionId: string): string | null {
  const gap = /^gap_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(questionId);
  if (gap?.[1] !== undefined && gap[2] !== undefined) return rangeText(gap[1], gap[2]);
  const likely = /^likely_closed_(\d{4}-\d{2}-\d{2})$/.exec(questionId);
  if (likely?.[1] !== undefined) return dayText(likely[1]);
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
      if (item.answer === 'other') return subject === null ? 'You answered a question in the chat.' : `You told TownwiseAI about ${subject} in the chat.`;
      if (subject === null) return item.answer === 'open' ? 'You said the data is missing.' : 'You weren’t sure about a question.';
      return item.answer === 'open' ? `You said the data is missing for ${subject}.` : `You weren’t sure about ${subject}.`;
    }
    // F3: a stored file Townwise read. Never its name: the files list shows that, and this panel is read under view-as.
    case 'file_processed':
      return `Read your file for ${rangeText(item.firstDate, item.lastDate)}, ${formatCount(item.dayCount)} ${item.dayCount === 1 ? 'day' : 'days'}.`;
    // D59: a change TownwiseAI saved on its own; the panel draws it with Undo (ActivityChange).
    case 'agent_change':
      return changeLine(item);
  }
}

function QuestionsSection(props: {
  panel: AgentPanelState;
  locationName: string;
  readOnlyId: string | null;
  chat: QuestionChat | null;
  send: SendToChat;
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
        panel={panel}
        locationName={props.locationName}
        readOnlyId={props.readOnlyId}
        chat={props.chat}
        send={props.send}
        place="panel"
      />
    ));
  }
  const open = openQuestions(panel);
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

/** D46: the open suggested closure rules, each with Confirm, Edit (a link to P29's form) and Dismiss; nothing when none. */
function RuleSuggestionsSection(props: { panel: AgentPanelState; locationId: string; readOnlyId: string | null }): React.JSX.Element | null {
  const { panel, locationId } = props;
  const { state } = panel;
  if (state.status !== 'ready' || state.data.ruleSuggestions.length === 0) return null;
  const open = openRuleSuggestions(panel) ?? 0;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Eyebrow>{toDecideLine(open)}</Eyebrow>
        <Heading>{SUGGESTED_COPY.panelHeading}</Heading>
      </View>
      {state.data.ruleSuggestions.map((suggestion) => (
        <RuleSuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          locationId={locationId}
          decisions={panel.rules}
          readOnlyId={props.readOnlyId}
          edit={{ href: `${locationHref(locationId, 'rules')}?suggestion=${encodeURIComponent(suggestion.id)}` }}
        />
      ))}
    </View>
  );
}

function ActivitySection(props: { panel: AgentPanelState; locationId: string; readOnlyId: string | null }): React.JSX.Element {
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
              {item.kind === 'agent_change'
                ? <ActivityChange item={item} locationId={props.locationId} readOnlyId={props.readOnlyId} />
                : <Text style={styles.itemText}>{activityLine(item)}</Text>}
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
      {state.status === 'ready' ? <WaitingLine waiting={state.data.waiting} locationId={props.locationId} /> : null}
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

function BudgetSection(props: { budget: Budget | null }): React.JSX.Element | null {
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

function HowItWorks(props: {
  ctx: ToolContext;
  locationId: string;
  about: LoadState<EstimatesAbout>;
  onRetryAbout: () => void;
  /** D59: whether TownwiseAI works on its own here: the organization's switch on and TOWNWISE_AGENT_AUTO on. */
  agentAuto: boolean;
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
          <Text style={styles.body}>It can search the web for public facts about the town, such as an event’s dates or the weather, and lists the pages it used.</Text>
          <Text style={styles.body}>It can’t see your staffing, your bookings unless you add them as notes, or guest names.</Text>
          <Text style={styles.body}>{savesLine(props.agentAuto)}</Text>
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
  /** The chat as a question's Something else… sees it; null while TownwiseAI's chat is off. */
  chat: QuestionChat | null;
  /** Sends Something else…'s message through the chat. */
  send: SendToChat;
  about: LoadState<EstimatesAbout>;
  onRetryAbout: () => void;
  /** False while the chat lists the questions itself (its landing, at 640px and below), so they aren't drawn twice. */
  showQuestions?: boolean;
}): React.JSX.Element {
  const ready = props.panel.state.status === 'ready' ? props.panel.state.data : null;
  // D59: the organization's choice once switched here, until the panel loads it again.
  const [switched, setSwitched] = useState<boolean | null>(null);
  // Working on its own only while the organization's switch is on and it can run here (TOWNWISE_AGENT_AUTO): off while
  // the panel loads, fails or comes from an API before it.
  const working = (switched ?? ready?.agentAuto?.on ?? false) && ready?.agentAuto?.available === true;
  return (
    <View style={styles.panel}>
      <RuleSuggestionsSection panel={props.panel} locationId={props.locationId} readOnlyId={props.readOnlyId} />
      {props.showQuestions === false ? null : (
        <QuestionsSection panel={props.panel} locationName={props.locationName} readOnlyId={props.readOnlyId} chat={props.chat} send={props.send} />
      )}
      <SuggestionsSection panel={props.panel} town={props.ctx.town} readOnlyId={props.readOnlyId} />
      {ready === null ? null : <AgentAutoSwitch agentAuto={ready.agentAuto} readOnlyId={props.readOnlyId} on={switched} onSwitched={setSwitched} />}
      {ready === null ? null : <NoteSuggestionsSection suggestions={ready.noteSuggestions} locationId={props.locationId} readOnlyId={props.readOnlyId} />}
      <ActivitySection panel={props.panel} locationId={props.locationId} readOnlyId={props.readOnlyId} />
      <BudgetSection budget={props.budget} />
      <HowItWorks
        ctx={props.ctx}
        locationId={props.locationId}
        about={props.about}
        onRetryAbout={props.onRetryAbout}
        agentAuto={working}
      />
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
