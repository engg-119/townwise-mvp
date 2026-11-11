import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { HistoryUpload } from '../analytics/api';
import { heatmapSummary } from '../analytics/cells';
import type { DayContext } from '../analytics/days';
import { Heatmap } from '../analytics/Heatmap';
import type { DayRecord } from '../analytics/history';
import type { Metric } from '../analytics/words';
import { formatDate, plural } from '../format';
import { UploadAction } from '../locations/parts';
import { UPLOADS_OFF_LINE } from '../locations/sales';
import { locationHref } from '../routing';
import type { Coverage } from '../schemas';
import { Actions, LinkButton } from '../ui/Button';
import { Small } from '../ui/text';
import { Block } from './Block';

// Your history (home.md 2.6): how many days Townwise has for this location, the span, the missing days and the last
// finished upload, then the newest year as a small heatmap that takes no focus (web only; native has the words)
// and links to Analytics and Upload. The panel's root carries nativeID "home-history" so onboarding's Reading screen
// (onboarding/HistoryStep, historyMotion.web.ts) can animate its calendar into it; Home does nothing for that
// animation.

export const HISTORY_ID = 'home-history';
const MARKS = { townEvents: true, holidays: true, notes: true, closures: true } as const;
const EVERY_DAY = (): boolean => true;

function lastFinished(uploads: readonly HistoryUpload[]): HistoryUpload | undefined {
  return uploads.filter((upload) => upload.status === 'applied').sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
}

/** "Jan 1, 2024 to Nov 4, 2026. 3 missing days in between. Last upload Nov 4, 2026 by owner@example.com." */
export function historyLine(coverage: Coverage, uploads: readonly HistoryUpload[]): string {
  if (coverage.firstDate === null || coverage.lastDate === null) return '';
  const missing = coverage.missingDays === 0 ? 'No missing days in between.' : `${plural(coverage.missingDays, 'missing day', 'missing days')} in between.`;
  const last = lastFinished(uploads);
  const upload = last === undefined ? 'No finished upload.' : `Last upload ${formatDate(last.uploadedAt)} by ${last.uploadedByEmail}.`;
  return `${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}. ${missing} ${upload}`;
}

export function HistoryCard(props: {
  coverage: Coverage;
  uploadsOff?: boolean;
  uploads: readonly HistoryUpload[];
  days: readonly DayRecord[];
  context: DayContext;
  metric: Metric;
  locationId: string;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { coverage, days, context, metric, locationId } = props;
  const year = coverage.lastDate === null ? null : Number(coverage.lastDate.slice(0, 4));
  const years = useMemo(() => (year === null ? [] : [year]), [year]);
  const label = useMemo(
    () => heatmapSummary({ days, metric, context, included: EVERY_DAY, years }, null) ?? '',
    [days, metric, context, years],
  );
  const empty = coverage.dayCount === 0 || year === null;
  const off = empty && props.uploadsOff === true;
  return (
    <View nativeID={HISTORY_ID} style={styles.grow}>
      <Block label="Your history" eyebrow="Your history" title={empty ? (off ? 'No days shown' : 'No days yet') : plural(coverage.dayCount, 'day', 'days')}>
        {empty ? <Small>{off ? UPLOADS_OFF_LINE : 'No sales history yet for this location.'}</Small> : (
          <>
            <Small>{historyLine(coverage, props.uploads)}</Small>
            <Heatmap
              days={days}
              metric={metric}
              marks={MARKS}
              context={context}
              included={EVERY_DAY}
              years={years}
              interactive={false}
              label={label}
            />
          </>
        )}
        <Actions>
          {empty ? null : <LinkButton href={locationHref(locationId, 'analytics')} label="See it in Analytics" />}
          {off ? <LinkButton href={locationHref(locationId, 'data')} label="Open Your data" /> : null}
          <UploadAction locationId={locationId} variant="link" readOnlyId={props.readOnlyId} />
        </Actions>
      </Block>
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flexGrow: 1 },
});
