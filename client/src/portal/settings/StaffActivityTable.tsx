import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatDate, formatTime } from '../format';
import { DataTable } from '../ui/DataTable';
import { EmptyState } from '../ui/feedback';
import type { StaffActivity } from './api';
import { SETTINGS_COPY } from './copy';

// Townwise staff activity (spec P18, D9, 9.3): every staff action on the organization, newest first, with the
// staff email. When, Staff, the server's summary as the Action, and Reason and Until for view-as rows. A row that
// a staff_action.not_applied event qualifies adds “Didn’t take effect.”

/** A string prints in the table's mono style; a qualified row adds its note under the summary. */
function actionCell(event: StaffActivity): React.ReactNode {
  if (!event.notApplied) return event.summary;
  return (
    <View style={styles.action}>
      <Text style={styles.value}>{event.summary}</Text>
      <Text style={styles.note}>{SETTINGS_COPY.notApplied}</Text>
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
