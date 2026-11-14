import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';

import { useLoad } from '../hooks';
import { fetchForecast, monthRange, type ForecastGlanceDay } from '../estimates/api';
import { fetchOrderBoard } from '../orders/api';
import { usePortal } from '../PortalProvider';
import { Mono, Small } from '../ui/text';
import { guestForecastSentence, orderCoverSentence, orderForDay, REORDER_OVERVIEW } from './beside';

// Beside the month calendar: the selected day's published guest forecast, then how an order is built and whether
// this day sits in the next one. Each read fails on its own, so Home still shows the calendar.

function dayOf(days: readonly ForecastGlanceDay[], date: string): ForecastGlanceDay | null {
  return days.find((day) => day.date === date) ?? null;
}

export function BesideCalendar(props: { locationId: string; date: string }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, date } = props;
  const month = date.slice(0, 7);
  const forecast = useLoad(useCallback(
    () => fetchForecast(api, locationId, monthRange(month)),
    [api, locationId, month],
  ));
  const order = useLoad(useCallback(() => fetchOrderBoard(api, locationId), [api, locationId]));
  const guests = forecast.state.status === 'ready'
    ? guestForecastSentence(forecast.state.data.available ? dayOf(forecast.state.data.days, date) : null)
    : forecast.state.status === 'failed'
      ? 'Townwise couldn’t check the guest forecast for this day.'
      : 'Checking the published guest forecast.';
  const cover = order.state.status === 'failed'
    ? 'Townwise couldn’t check the next order.'
    : order.state.status !== 'ready'
      ? 'Checking the next order.'
      : order.state.data.available
        ? orderCoverSentence(date, orderForDay(date, order.state.data))
        : order.state.data.reason;
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
