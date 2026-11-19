import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useLoad } from '../../portal/hooks';
import { usePortal, useReadOnly } from '../../portal/PortalProvider';
import { locationHref } from '../../portal/routing';
import { useLocation } from '../../portal/shell/LocationShell';
import { Button, LinkButton } from '../../portal/ui/Button';
import { EmptyState, ErrorNotice, LoadingLine, ReadOnlyLine } from '../../portal/ui/feedback';
import { Section, Stack } from '../../portal/ui/layout';
import { Body } from '../../portal/ui/text';
import { theme } from '../../theme';
import { loadChanges, type AgentChange } from '../agentChanges';
import { ChangeLine } from './AgentChanges';

// The log of TownwiseAI's changes (D59, openspec change auto-apply-agent-reads design decision 11; P25's log page,
// /locations/[locationId]/agent/changes, members): every change it saved at the location, newest first, 50 a page,
// each with its why (none under view-as), what it was made from, and Undo while it may be undone. Under view-as it
// reads, and Undo stays hidden (the server offers none).

const READ_ONLY_ID = 'changes-ro';

const WHEN = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

function whenText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : WHEN.format(date);
}

function ChangeRow(props: { change: AgentChange; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { change } = props;
  return (
    <View role="listitem" style={styles.row}>
      <Text style={styles.when}>{whenText(change.at)}</Text>
      <ChangeLine change={change} locationId={props.locationId} readOnlyId={props.readOnlyId} textStyle={styles.line} />
      {change.why === null ? null : <Text style={styles.why}>{`Why: ${change.why}`}</Text>}
    </View>
  );
}

export function ChangesPage(): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const { readOnly, line } = useReadOnly();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const first = useLoad(useCallback(() => loadChanges(api, location.id), [api, location.id]));
  const [older, setOlder] = useState<{ changes: AgentChange[]; next: string | null | undefined; pending: boolean; failed: boolean }>({
    changes: [], next: undefined, pending: false, failed: false,
  });
  const { state } = first;
  const next = older.next === undefined ? (state.status === 'ready' ? state.data.next : null) : older.next;
  const more = (): void => {
    if (older.pending || next === null) return;
    setOlder((current) => ({ ...current, pending: true, failed: false }));
    loadChanges(api, location.id, next).then(
      (page) => { setOlder((current) => ({ changes: [...current.changes, ...page.changes], next: page.next, pending: false, failed: false })); },
      () => { setOlder((current) => ({ ...current, pending: false, failed: true })); },
    );
  };
  let body: React.ReactNode;
  if (state.status === 'loading') body = <LoadingLine text="Loading TownwiseAI’s changes" />;
  else if (state.status === 'failed') body = <ErrorNotice message="Couldn’t load TownwiseAI’s changes." onRetry={first.reload} />;
  else if (state.data.changes.length === 0) body = <EmptyState text="TownwiseAI hasn’t changed anything here on its own yet." />;
  else {
    body = (
      <Stack>
        <View role="list" aria-label="TownwiseAI’s changes" style={styles.list}>
          {[...state.data.changes, ...older.changes].map((change) => (
            <ChangeRow key={change.id} change={change} locationId={location.id} readOnlyId={readOnlyId} />
          ))}
        </View>
        {next === null ? null : (
          <Button variant="outline" label={older.pending ? 'Loading…' : 'Show older changes'} disabled={older.pending} onPress={more} />
        )}
        {older.failed ? <ErrorNotice message="Couldn’t load older changes." /> : null}
      </Stack>
    );
  }
  return (
    <Stack>
      {readOnly ? <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} /> : null}
      <Section first kicker="TownwiseAI" title="Every change it made on its own">
        <Body>
          Each note, summary or set of sales days TownwiseAI saved here, newest first. Undo removes what it added, as long as nobody changed it
          since. Once you change something it added, it’s yours.
        </Body>
        <LinkButton href={locationHref(location.id, 'agent')} label="Back to TownwiseAI" />
        {body}
      </Section>
    </Stack>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { gap: theme.space[4] },
  row: { gap: 2, paddingBottom: theme.space[3], borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border },
  when: { ...theme.type.mono, color: c.text3 },
  line: { ...theme.type.body, color: c.white },
  why: { ...theme.type.small, color: c.text2 },
});
