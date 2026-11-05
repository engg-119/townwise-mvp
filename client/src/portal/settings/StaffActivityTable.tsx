import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatDate, formatTime } from '../format';
import { DataTable } from '../ui/DataTable';
import { EmptyState } from '../ui/feedback';
import type { StaffActivity } from './api';
import { SETTINGS_COPY } from './copy';

// Townwise staff activity (spec P18, D9, 9.3): every staff action on the organization, newest first, with the
// staff email. When, Staff, the server's summary as the Action, and Reason and Until for view-as rows. A refused
// action is one row (`applied: false`): it adds “Didn’t take effect.” and the server's reason in plain words.

/** The reason as a sentence: the server sends it without a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A string prints in the table's mono style; a refused row adds its note and reason under the summary. */
function actionCell(event: StaffActivity): React.ReactNode {
  if (event.applied) return event.summary;
  return (
    <View style={styles.action}>
      <Text style={styles.value}>{event.summary}</Text>
      <Text style={styles.note}>{SETTINGS_COPY.notApplied}</Text>
      {event.notAppliedReason === null ? null : <Text style={styles.note}>{sentence(event.notAppliedReason)}</Text>}
    </View>
  );
}

export function StaffActivityTable(props: { org: string; events: readonly StaffActivity[] }): React.JSX.Element {
  if (props.events.length === 0) return <EmptyState text={SETTINGS_COPY.staffEmpty} />;
  return (
    <DataTable
      label={`Townwise staff activity on ${props.org}`}
      columns={[
        { key: 'when', label: 'When' },
        { key: 'staff', label: 'Staff', flex: 1.4 },
        { key: 'action', label: 'Action', flex: 1.6 },
        { key: 'reason', label: 'Reason', flex: 1.2 },
        { key: 'until', label: 'Until', flex: 0.7 },
      ]}
      rows={props.events.map((event, index) => ({
        key: `${String(index)}-${event.at}`,
        cells: {
          when: `${formatDate(event.at)}, ${formatTime(event.at)}`,
          staff: `Townwise staff (${event.staffEmail})`,
          action: actionCell(event),
          reason: event.viewAs?.reason ?? '',
          until: event.viewAs === null ? '' : formatTime(event.viewAs.endsAt),
        },
      }))}
    />
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  action: { gap: 2, minWidth: 0 },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  note: { ...theme.type.small, color: c.text2 },
});
