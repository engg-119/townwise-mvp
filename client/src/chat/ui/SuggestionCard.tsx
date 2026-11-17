import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { openAsAdminOrgId } from '../../portal/api';
import { usePortal } from '../../portal/PortalProvider';
import { Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { Eyebrow, Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { Suggestion } from '../api';
import { dayText, formatCount, KIND_LABEL, rangeText, weekdaysText } from '../format';
import { openSuggestions, type AgentPanelState, type Decided } from '../useAgentPanel';

// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions, spec P25): each Monday a pass reads the
// next 3 months of the town's calendar with the location's notes and rules and suggests notes or business rules. A
// card asks the question, gives TownwiseAI's one-sentence why and the calendar entries it rests on, and offers Accept
// and Dismiss to org admins only; members see the card without them. Nothing changes the forecast until an admin
// accepts. Under the cards, the organization's switch with its words: admins turn it off or on, members see its state.

/** The switch's words (spec P25), with the town's name. */
export function weeklyWords(town: string): string {
  return `Each Monday TownwiseAI reads the next 3 months of ${town}’s calendar with your notes and rules, and suggests notes or rules for you to accept. It sends them to Anthropic and uses this organization’s TownwiseAI budget.`;
}

/** The days a suggestion names: "Thu, Nov 26, 2026", "Dec 24 to Dec 26, 2026", with its weekdays and an open end. */
function daysOf(startDate: string, endDate: string | null, weekdays: readonly number[] | null): string {
  const dates = endDate === null ? `from ${dayText(startDate)} on` : startDate === endDate ? dayText(startDate) : rangeText(startDate, endDate);
  const which = weekdaysText(weekdays);
  return which === null ? dates : `${which.replace(/ only$/, '')}, ${dates}`;
}

/** The card's question. */
export function suggestionHeading(suggestion: Suggestion): string {
  if (suggestion.type === 'rule') return `Add the rule “${suggestion.text}”?`;
  const { note } = suggestion;
  const days = daysOf(note.startDate, note.endDate, note.weekdays);
  if (note.kind === 'closure' || (note.effect === 'closed' && note.kind !== 'private_event')) return `Closed on ${days}?`;
  if (note.kind === 'private_event' && note.effect === 'closed') {
    return note.expectedGuests === null ? `Booked for a private party on ${days}?` : `Booked for a private party of ${formatCount(note.expectedGuests)} on ${days}?`;
  }
  if (note.kind === 'private_event' && note.expectedGuests !== null) return `A private event of ${formatCount(note.expectedGuests)} guests on ${days}?`;
  return `${KIND_LABEL[note.kind]} on ${days}?`;
}

/** What Accept does, and who can press it. */
export function suggestionHelp(suggestion: Suggestion, canChange: boolean): string {
  if (!canChange) return 'An admin of your organization can accept or dismiss this.';
  return suggestion.type === 'rule'
    ? 'Accept adds this business rule, and the forecast uses its schedule from then on. Dismiss and TownwiseAI won’t suggest it again.'
    : 'Accept saves this note, and the forecast uses it from then on. Dismiss and TownwiseAI won’t suggest it again.';
}

/** What the decision did. */
export function decidedLine(suggestion: Suggestion, decided: Decided): string {
  if (decided.status === 'dismissed') return 'Dismissed. TownwiseAI won’t suggest it again.';
  if (suggestion.type === 'rule') return `Added the business rule “${suggestion.text}”.`;
  const { note } = suggestion;
  return `Saved a note: ${KIND_LABEL[note.kind]}, ${daysOf(note.startDate, note.endDate, note.weekdays)}.`;
}

/** "Based on Commencement (Jun 14)". Null when it names none. */
function basedOn(suggestion: Suggestion): string | null {
  if (suggestion.calendar.length === 0) return null;
  return `Based on ${suggestion.calendar.map((entry) => `${entry.title} (${entry.start === entry.end ? dayText(entry.start) : rangeText(entry.start, entry.end)})`).join(', ')}.`;
}

export function SuggestionCard(props: {
  suggestion: Suggestion;
  panel: AgentPanelState;
  canChange: boolean;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { suggestion, panel } = props;
  const { id } = suggestion;
  const helpId = `suggestion-${id}-help`;
  const decided = panel.decided[id];
  const error = panel.suggestionErrors[id];
  const deciding = panel.deciding === id;
  const off = props.readOnlyId !== null || panel.deciding !== null;
  const based = basedOn(suggestion);
  const describedBy = [props.readOnlyId, helpId].filter((value): value is string => value !== null).join(' ');
  return (
    <View style={styles.card}>
      <Heading level={3}>{suggestionHeading(suggestion)}</Heading>
      <Text style={styles.context}>{suggestion.why}</Text>
      {suggestion.type === 'rule' ? <Text style={styles.context}>{suggestion.scheduleSummary}</Text> : null}
      {based === null ? null : <Text style={styles.help}>{based}</Text>}
      {decided !== undefined ? <Text role="status" style={styles.done}>{decidedLine(suggestion, decided)}</Text> : (
        <>
          {props.canChange ? (
            <View role="group" aria-label={suggestionHeading(suggestion)} style={styles.answers}>
              <Button variant="outline" label="Accept" disabled={off} describedBy={describedBy} onPress={() => { panel.decide(id, 'accept'); }} />
              <Button variant="outline" label="Dismiss" disabled={off} describedBy={describedBy} onPress={() => { panel.decide(id, 'dismiss'); }} />
            </View>
          ) : null}
          <Text nativeID={helpId} style={styles.help}>{deciding ? 'Saving…' : suggestionHelp(suggestion, props.canChange)}</Text>
        </>
      )}
      {error === undefined || decided !== undefined ? null : <ErrorNotice message={error} />}
    </View>
  );
}

/** The switch: its words and a button for admins, its state for members, and a line while the server can't run passes. */
function WeeklySwitch(props: { panel: AgentPanelState; town: string; readOnlyId: string | null }): React.JSX.Element | null {
  const { me } = usePortal();
  const { panel } = props;
  if (panel.state.status !== 'ready') return null;
  const weekly = panel.state.data.weeklySuggestions;
  if (weekly === null) return null;
  const on = panel.weeklyOn ?? weekly.on;
  return (
    <View style={styles.switch}>
      <Text style={styles.body}>
        {weeklyWords(props.town)}{' '}
        <Link href="/privacy" style={styles.link}>Privacy</Link>
      </Text>
      <Text style={styles.body}>{on ? 'Weekly suggestions are on.' : 'Weekly suggestions are off.'}</Text>
      {on && !weekly.available ? <Text style={styles.help}>Weekly suggestions aren’t running right now, so none are being made.</Text> : null}
      {weekly.canChange ? (
        <Button
          variant="outline"
          label={on ? 'Turn off weekly suggestions' : 'Turn on weekly suggestions'}
          disabled={props.readOnlyId !== null || panel.switching}
          {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
          onPress={() => { panel.setWeekly(!on, openAsAdminOrgId(me)); }}
        />
      ) : null}
      {panel.switchError === null ? null : <ErrorNotice message={panel.switchError} />}
    </View>
  );
}

/** Suggested for the next 3 months: the open suggestions, then the switch. */
export function SuggestionsSection(props: { panel: AgentPanelState; town: string; readOnlyId: string | null }): React.JSX.Element | null {
  const { panel } = props;
  const { state } = panel;
  let body: React.ReactNode;
  if (state.status === 'loading') body = <LoadingLine text="Loading suggestions" minHeight={80} />;
  else if (state.status === 'failed') return null;
  else if (state.data.suggestions.length === 0) body = <Text style={styles.muted}>No suggestions right now.</Text>;
  else {
    const canChange = state.data.weeklySuggestions?.canChange === true;
    body = state.data.suggestions.map((suggestion) => (
      <SuggestionCard key={suggestion.id} suggestion={suggestion} panel={panel} canChange={canChange} readOnlyId={props.readOnlyId} />
    ));
  }
  const open = openSuggestions(panel);
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        {open === null ? null : <Eyebrow>{`${formatCount(open)} to decide`}</Eyebrow>}
        <Heading>Suggested for the next 3 months</Heading>
      </View>
      {body}
      <WeeklySwitch panel={panel} town={props.town} readOnlyId={props.readOnlyId} />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  section: { gap: theme.space[3] },
  head: { gap: theme.space[1] },
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  context: { ...theme.type.small, color: c.text2 },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2], alignItems: 'flex-start' },
  help: { ...theme.type.small, color: c.text3 },
  done: { ...theme.type.small, color: c.white },
  muted: { ...theme.type.small, color: c.text3, flexShrink: 1 },
  switch: { gap: theme.space[2], alignItems: 'flex-start' },
  body: { ...theme.type.small, color: c.text2 },
  link: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
});
