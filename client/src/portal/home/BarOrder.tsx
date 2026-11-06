import { StyleSheet, View } from 'react-native';

import { lateWeekLine, type lateWeekShare } from '../analytics/week';
import type { Metric } from '../analytics/words';
import { StatusTag } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Eyebrow, Heading, Small } from '../ui/text';

// Bar order (home.md 2.3), Planned: order suggestions need a forecast and the restaurant's usual weekly order, and
// Townwise has neither, so the card says so and offers no inputs. Its one figure is history: last year's same week,
// Thursday to Sunday's share of the week, and only when all four of those days have data.

export const BAR_ORDER_BODY = 'Townwise will suggest how much more or less beer, wine and spirits to order each week, and by when. It needs a forecast and your usual weekly order first. Townwise can’t see your stock.';

export function BarOrder(props: { share: ReturnType<typeof lateWeekShare>; metric: Metric }): React.JSX.Element {
  return (
    <Panel label="Bar order">
      <Stack gap={8}>
        <View style={styles.head}>
          <Eyebrow>Bar order</Eyebrow>
          <StatusTag kind="planned" label="Planned" />
        </View>
        <Heading level={3}>Order suggestions are planned</Heading>
      </Stack>
      <Small>{BAR_ORDER_BODY}</Small>
      {props.share === null ? null : <Small white>{lateWeekLine(props.share, props.metric)}</Small>}
    </Panel>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
});
