import { lateWeekLine, type lateWeekShare } from '../analytics/week';
import type { Metric } from '../analytics/words';
import { StatusTag } from '../ui/feedback';
import { Small } from '../ui/text';
import { Block } from './Block';

// Bar order (home.md 2.3), Planned: order suggestions need a forecast and the restaurant's usual weekly order, and
// Townwise has neither, so the card says so and offers no inputs. Its one figure is history: last year's same week,
// Thursday to Sunday's share of the week, and only when all four of those days have data.

export const BAR_ORDER_BODY = 'Townwise will suggest how much more or less beer, wine and spirits to order each week, and by when. It needs a forecast and your usual weekly order first. Townwise can’t see your stock.';

export function BarOrder(props: { share: ReturnType<typeof lateWeekShare>; metric: Metric }): React.JSX.Element {
  return (
    <Block label="Bar order" eyebrow="Bar order" tag={<StatusTag kind="planned" label="Planned" />} title="Order suggestions are planned">
      <Small>{BAR_ORDER_BODY}</Small>
      {props.share === null ? null : <Small white>{lateWeekLine(props.share, props.metric)}</Small>}
    </Block>
  );
}
