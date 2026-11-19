import { Link } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { openAsAdminOrgId } from '../../portal/api';
import { usePortal } from '../../portal/PortalProvider';
import { locationHref } from '../../portal/routing';
import { Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice } from '../../portal/ui/feedback';
import { Eyebrow, Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import {
  AGENT_AUTO_WORDS, changeLine, decideNoteSuggestion, setAgentAuto, undoChange, undoErrorFinal, undoErrorText, waitingLine,
  type AgentAuto, type AgentChange, type AgentChangeItem, type NoteSuggestion,
} from '../agentChanges';
import { KIND_LABEL, rangeText } from '../format';

// D59 (openspec change auto-apply-agent-reads, design decisions 10, 11 and 13) in TownwiseAI's panel (P25): a change
// TownwiseAI saved on its own, as an activity line with Undo (no title, why, file name or figure: the log has the why),
// the line that counts what is waiting, the events a file read wasn't sure of with Add the note and Dismiss, and the
// organization's switch beside the weekly one. Under view-as everything reads and nothing writes: the server offers no
// Undo there and refuses every write, and each control is disabled, described by the read-only line.

/** The log of every change (the page under TownwiseAI). */
export function changesHref(locationId: string): string {
  return `${locationHref(locationId, 'agent')}/changes`;
}

/** One change: its line, and Undo while it may be undone here. */
export function ChangeLine(props: {
  change: Pick<AgentChange, 'action' | 'noteKind' | 'startDate' | 'endDate' | 'count' | 'sourceKind' | 'status' | 'undoable'> & { id: string };
  locationId: string;
  readOnlyId: string | null;
  /** The line's own style (the activity's or the log's). */
  textStyle?: object;
}): React.JSX.Element {
  const { api } = usePortal();
  const { change } = props;
  const [state, setState] = useState<{ status: AgentChange['status']; undoing: boolean; error: string | null; final: boolean }>({
    status: change.status, undoing: false, error: null, final: false,
  });
  const undo = (): void => {
    if (state.undoing) return;
    setState((current) => ({ ...current, undoing: true, error: null }));
    undoChange(api, props.locationId, change.id).then(
      (after) => { setState({ status: after.status, undoing: false, error: null, final: false }); },
      (error: unknown) => {
        setState((current) => ({ ...current, undoing: false, error: undoErrorText(error, change.action), final: undoErrorFinal(error) }));
      },
    );
  };
  // A final refusal (changed since, gone, not allowed) takes Undo away; any other failure leaves it to try again.
  const offered = change.undoable && state.status === 'applied' && !state.final;
  return (
    <View style={styles.change}>
      <Text style={props.textStyle ?? styles.itemText}>{changeLine({ ...change, status: state.status })}</Text>
      {offered ? (
        <Button
          variant="link"
          label={state.undoing ? 'Undoing…' : 'Undo'}
          accessibilityLabel={`Undo: ${changeLine(change)}`}
          disabled={props.readOnlyId !== null || state.undoing}
          {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
          onPress={undo}
        />
      ) : null}
      {state.error === null ? null : <ErrorNotice message={state.error} />}
    </View>
  );
}

/** An activity item for a change, as ChangeLine draws it. */
export function ActivityChange(props: { item: AgentChangeItem; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  return <ChangeLine change={{ ...props.item, id: props.item.changeId }} locationId={props.locationId} readOnlyId={props.readOnlyId} />;
}

/** "{n} things TownwiseAI wasn't sure of are waiting for you", and the log's link. */
export function WaitingLine(props: { waiting: number; locationId: string }): React.JSX.Element {
  const line = waitingLine(props.waiting);
  return (
    <View style={styles.change}>
      {line === null ? null : <Text style={styles.body}>{line}</Text>}
      <LinkButton href={changesHref(props.locationId)} label="Every change TownwiseAI made" />
    </View>
  );
}

/** One event a file read wasn't sure of: what it says and where it came from, with Add the note and Dismiss. */
function NoteSuggestionCard(props: { suggestion: NoteSuggestion; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { api } = usePortal();
  const { suggestion } = props;
  const { note } = suggestion;
  const [state, setState] = useState<{ deciding: boolean; decided: 'accepted' | 'dismissed' | null; error: string | null }>({
    deciding: false, decided: null, error: null,
  });
  const decide = (decision: 'accept' | 'dismiss'): void => {
    if (state.deciding) return;
    setState({ deciding: true, decided: null, error: null });
    decideNoteSuggestion(api, props.locationId, suggestion.id, decision).then(
      (result) => { setState({ deciding: false, decided: result.status, error: null }); },
      () => { setState({ deciding: false, decided: null, error: 'Couldn’t save that. Try again.' }); },
    );
  };
  const what = `${KIND_LABEL[note.kind]}, ${rangeText(note.startDate, note.endDate)}${note.title === null ? '' : `: ${note.title}`}`;
  const canDecide = suggestion.canDecide && props.readOnlyId === null && state.decided === null;
  return (
    <View style={styles.card}>
      <Text style={styles.itemText}>{what}</Text>
      <Text style={styles.body}>
        {suggestion.file === null ? 'From a file you added, since deleted.' : `From ${suggestion.file.title ?? 'a file you added'}.`}
      </Text>
      {state.decided === null ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            label="Add the note"
            disabled={!canDecide || state.deciding}
            {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
            onPress={() => { decide('accept'); }}
          />
          <Button
            variant="link"
            label="Dismiss"
            disabled={!canDecide || state.deciding}
            {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
            onPress={() => { decide('dismiss'); }}
          />
        </View>
      ) : (
        <Text role="status" style={styles.done}>{state.decided === 'accepted' ? 'Added to Notes.' : 'Dismissed. Nothing was added.'}</Text>
      )}
      {state.error === null ? null : <ErrorNotice message={state.error} />}
    </View>
  );
}

/** "Not sure yet": the events files stated that TownwiseAI wasn't sure of; nothing when none. */
export function NoteSuggestionsSection(props: { suggestions: readonly NoteSuggestion[]; locationId: string; readOnlyId: string | null }): React.JSX.Element | null {
  if (props.suggestions.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Eyebrow>{`${String(props.suggestions.length)} to decide`}</Eyebrow>
        <Heading>Not sure from your files</Heading>
      </View>
      {props.suggestions.map((suggestion) => (
        <NoteSuggestionCard key={suggestion.id} suggestion={suggestion} locationId={props.locationId} readOnlyId={props.readOnlyId} />
      ))}
    </View>
  );
}

/**
 * The switch: its words and a button for an org admin, its state for members, and a line while it can't run here (the
 * deploy switch off: the state then reads off, whatever the organization's choice). Staff open as admin may turn it off
 * but not on (the organization's own consent). `on` is the choice once switched here, which the panel shares with How
 * TownwiseAI works; null until then.
 */
export function AgentAutoSwitch(props: {
  agentAuto: AgentAuto | null;
  readOnlyId: string | null;
  on: boolean | null;
  onSwitched: (on: boolean) => void;
}): React.JSX.Element | null {
  const { api, me } = usePortal();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { agentAuto, onSwitched } = props;
  if (agentAuto === null) return null;
  const current = props.on ?? agentAuto.on;
  const openAsAdmin = openAsAdminOrgId(me);
  const press = (): void => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    setAgentAuto(api, !current, openAsAdmin).then(
      (now) => { onSwitched(now); },
      () => { setError('Couldn’t change this. Try again.'); },
    ).finally(() => { setSwitching(false); });
  };
  return (
    <View style={styles.section}>
      <Heading>Working on its own</Heading>
      <Text style={styles.body}>
        {AGENT_AUTO_WORDS}{' '}
        <Link href="/privacy" style={styles.link}>Privacy</Link>
      </Text>
      <Text style={styles.body}>{current && agentAuto.available ? 'TownwiseAI works on its own.' : 'TownwiseAI works on its own is off.'}</Text>
      {current && !agentAuto.available ? <Text style={styles.help}>It isn’t running here right now, so it reads nothing on its own.</Text> : null}
      {agentAuto.canChange && (current || openAsAdmin === null) ? (
        <Button
          variant="outline"
          label={current ? 'Turn off working on its own' : 'Turn on working on its own'}
          disabled={props.readOnlyId !== null || switching}
          {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
          onPress={press}
        />
      ) : null}
      {agentAuto.canChange && openAsAdmin !== null ? (
        <Text style={styles.help}>{current ? 'You can turn this off. Only an admin of this organization can turn it back on.' : 'Only an admin of this organization can turn this on.'}</Text>
      ) : null}
      {error === null ? null : <ErrorNotice message={error} />}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  section: { gap: theme.space[3] },
  head: { gap: theme.space[1] },
  change: { gap: 2, alignItems: 'flex-start' },
  itemText: { ...theme.type.small, color: c.white },
  body: { ...theme.type.small, color: c.text2 },
  help: { ...theme.type.small, color: c.text3 },
  done: { ...theme.type.small, color: c.white },
  link: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2], alignItems: 'center' },
  card: {
    gap: theme.space[2], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
});
