import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { calendarHref } from '../routing';
import { Actions, Button, LinkButton } from '../ui/Button';
import { useRowFocus } from '../ui/DataTable';
import { Panel } from '../ui/layout';
import { PhraseParts } from '../ui/PhraseParts';
import { Heading, Mono, Small } from '../ui/text';
import { driverDayPhrase, driverSummaryPhrase, type Driver } from './aggregates';
import { shortDate, type Metric } from './words';

// A driver's days (P24 Biggest drivers; owner request, 2026-11-15). A press on a driver's row, or on its name (a
// button, the keyboard's way in), opens this panel under the table, its row selected: the effect, then each day it was measured on, oldest first, with
// the event that day, its own figure against its usual and the change (figures bold, as Home's), and a link to the day
// in the Calendar. Pressing the name again, or Close, shuts it. A note's day shows no words of the note: those stay in
// Notes, read with their own permissions.

/** The driver's name in its table cell: the keyboard's and screen readers' way in; a press anywhere on the row does the same. */
export function DriverButton(props: { label: string; open: boolean; onPress: () => void }): React.JSX.Element {
  const focus = useRowFocus();
  return (
    <Pressable
      role="button"
      aria-expanded={props.open}
      onPress={props.onPress}
      onFocus={() => { focus?.(true); }}
      onBlur={() => { focus?.(false); }}
      style={styles.name}
    >
      <Text style={[styles.nameText, props.open ? styles.nameOpen : null]}>{props.label}</Text>
    </Pressable>
  );
}

export function DriverDetail(props: { driver: Driver; metric: Metric; locationId: string; onClose: () => void }): React.JSX.Element {
  const { driver, metric } = props;
  return (
    <Panel label={`${driver.label}, day by day`}>
      <View style={styles.body}>
        <Heading level={3}>{driver.label}</Heading>
        <Small white><PhraseParts phrase={driverSummaryPhrase(driver)} /></Small>
        <View style={styles.days}>
          {driver.days.map((day) => (
            <View key={day.date} style={styles.day}>
              {day.title === null ? null : <Small white>{day.title}</Small>}
              <Mono tone="white"><PhraseParts phrase={driverDayPhrase(day, metric)} /></Mono>
              <Actions>
                <LinkButton
                  variant="link"
                  href={calendarHref(props.locationId, day.date)}
                  label="Open in the Calendar"
                  accessibilityLabel={`Open ${shortDate(day.date)} in the Calendar`}
                />
              </Actions>
            </View>
          ))}
        </View>
        <Actions><Button variant="outline" label="Close" onPress={props.onClose} /></Actions>
      </View>
    </Panel>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  name: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  nameText: {
    ...theme.type.mono, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line,
  },
  nameOpen: { textDecorationColor: c.white },
  body: { gap: theme.space[3] },
  days: { gap: theme.space[4] },
  day: { gap: theme.space[1] },
});
