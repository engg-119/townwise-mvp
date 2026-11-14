import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';

import { useLoad, type LoadState } from '../hooks';
import { fetchForecast, monthRange, type ForecastGlanceDay } from '../estimates/api';
import type { OrderBoard } from '../orders/api';
import { usePortal } from '../PortalProvider';
import { Mono, Small } from '../ui/text';
import { guestForecastSentence, orderCoverSentence, orderForDay, REORDER_OVERVIEW } from './beside';

// Beside the month calendar: the selected day's published guest forecast, then how an order is built and whether
// this day sits in the next one. It reads the month's forecast; the board is Home's one read, shared with Bar order.
// Each fails on its own, so Home still shows the calendar.

function dayOf(days: readonly ForecastGlanceDay[], date: string): ForecastGlanceDay | null {
  return days.find((day) => day.date === date) ?? null;
}

export function BesideCalendar(props: { locationId: string; date: string; board: LoadState<OrderBoard> }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, date, board: order } = props;
  const month = date.slice(0, 7);
  const forecast = useLoad(useCallback(
    () => fetchForecast(api, locationId, monthRange(month)),
    [api, locationId, month],
  ));
  const guests = forecast.state.status === 'ready'
    ? guestForecastSentence(forecast.state.data.available ? dayOf(forecast.state.data.days, date) : null)
    : forecast.state.status === 'failed'
      ? 'Townwise couldn’t check the guest forecast for this day.'
      : 'Checking the published guest forecast.';
  const cover = order.status === 'failed'
    ? 'Townwise couldn’t check the next order.'
    : order.status !== 'ready'
      ? 'Checking the next order.'
      : order.data.available
        ? orderCoverSentence(date, orderForDay(date, order.data))
        : order.data.reason;
  return (
    <View style={styles.root}>
      <View style={styles.part}>
        <Mono tone="text3">Guest forecast</Mono>
        <Small white>{guests}</Small>
      </View>
      <View style={styles.part}>
        <Mono tone="text3">Reorder</Mono>
        <Small>{REORDER_OVERVIEW}</Small>
        <Small white>{cover}</Small>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[4] },
  part: { gap: theme.space[1] },
});
