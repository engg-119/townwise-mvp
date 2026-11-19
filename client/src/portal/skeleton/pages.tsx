import { useState } from 'react';
import { Platform, StyleSheet, Text, View, type DimensionValue, type LayoutChangeEvent } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { plainOf } from '../analytics/phrase';
import {
  calendarCoverageLine, forecastDayPhrase, LAST_YEAR_FOOTNOTE, lastYearBesidePhrase, monthFactLine, weekForecastLabel, weekRangePhrase, WIDE_CELL,
  WIDE_CELL_HEIGHT,
} from '../analytics/week';
import { cellSize } from '../calendar/grid';
import { FIGURE_KEY, FORECAST_TAG, markedFigure } from '../calendar/model';
import { noNumberLine } from '../estimates/format';
import { BlockRow, GUTTER } from '../home/Block';
import { MONTH_INTRO } from '../home/ThisMonth';
import { BARS_FOOTNOTE } from '../home/ThisWeek';
import { Actions } from '../ui/Button';
import { Columns, Pair, Panel, Section, Stack } from '../ui/layout';
import {
  Skeleton, SkeletonBlock, SkeletonButton, SkeletonChart, SkeletonDefinitions, SkeletonField, SkeletonFigure, SkeletonHeading, SkeletonPanel,
  SkeletonTable, SkeletonText, SkeletonWords, type SkeletonColumn,
} from './kit';

// The loading state of each client app, gate and account page (spec 16.2, 16.3): the page's own sections, columns
// and tables in skeleton shapes, inside the frame and header the page already draws, with the page's loading words
// as the one status line. Each page passes its words (`label`), so they stay where they were.

const c = theme.color;

interface LabelProps { label: string }

/** A table on its own (Team's members, Your data's items): the table's columns, a few rows. */
export function TableSkeleton(props: LabelProps & { name: string; columns: readonly SkeletonColumn[]; rows?: number; rowHeight?: number }): React.JSX.Element {
  return (
    <Skeleton name={props.name} label={props.label}>
      <SkeletonTable
        columns={props.columns}
        {...(props.rows === undefined ? {} : { rows: props.rows })}
        {...(props.rowHeight === undefined ? {} : { rowHeight: props.rowHeight })}
      />
    </Skeleton>
  );
}

/** P9 Locations: Where each location stands (the table), then Your towns (a panel per town) and the caveats. */
export function LocationsSkeleton(props: LabelProps): React.JSX.Element {
  const { desktop } = useBreakpoint();
  return (
    <Skeleton name="locations" label={props.label}>
      <Section first>
        <SkeletonHeading kicker />
        <SkeletonTable
          columns={[{ flex: 1.2 }, {}, { flex: 1.2 }, {}, { flex: 0.8 }, { flex: 1.2 }]}
          rows={3}
          // The name's 44px link and the cell's padding.
          rowHeight={56}
        />
      </Section>
      <Section>
        <SkeletonHeading kicker width={200} />
        <View style={[styles.towns, desktop ? styles.townsRow : null]}>
          {[0, 1].map((town) => (
            <View key={town} style={desktop ? styles.town : null}>
              <Panel>
                <SkeletonHeading width={180} />
                <SkeletonText lines={2} />
                <SkeletonText width="70%" />
                <SkeletonText />
                <SkeletonText type="mono" width="80%" />
                <SkeletonButton link width={180} />
              </Panel>
            </View>
          ))}
        </View>
        <Stack gap={4}><SkeletonText type="mono" lines={3} /></Stack>
      </Section>
    </Skeleton>
  );
}

/**
 * P18 Settings for an org admin, which waits for the staff activity: Your account and Two-step sign-in, the
 * organization's name beside Add location, Townwise staff activity, Leave and Sign out.
 */
export function SettingsSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="settings" label={props.label}>
      <Section first>
        <Columns
          main={(
            <Section first>
              <SkeletonHeading kicker width={200} />
              <SkeletonDefinitions rows={3} />
              <SkeletonField helper />
              <Actions><SkeletonButton width={150} /></Actions>
            </Section>
          )}
          side={(
            <Section first>
              <SkeletonHeading kicker width={220} />
              <SkeletonText width={200} />
              <SkeletonButton link width={210} />
            </Section>
          )}
        />
      </Section>
      <Section>
        <Columns
          main={(
            <Section first>
              <SkeletonHeading kicker width={240} />
              <SkeletonField helper />
              <Actions><SkeletonButton width={130} /></Actions>
            </Section>
          )}
          side={(
            <Stack>
              <SkeletonText lines={3} />
              <Actions><SkeletonButton width={140} /></Actions>
            </Stack>
          )}
        />
      </Section>
      <Section>
        <SkeletonHeading kicker width={300} />
        <View style={styles.measure}><SkeletonText lines={5} /></View>
        <SkeletonTable columns={[{}, { flex: 1.4 }, { flex: 1.6 }, { flex: 1.2 }, { flex: 0.7 }]} rows={3} />
      </Section>
      <Section>
        <SkeletonHeading kicker width={220} />
        <SkeletonText width="80%" />
        <Actions><SkeletonButton width={140} /></Actions>
      </Section>
      <Section>
        <SkeletonHeading kicker width={120} />
        <SkeletonText lines={2} />
        <Actions><SkeletonButton width={110} /><SkeletonButton width={210} /></Actions>
      </Section>
    </Skeleton>
  );
}

/** P14 Notes, under the intro: Add a note, then Coming up and its table. */
export function NotesSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="notes" label={props.label}>
      <Stack gap={32}>
        <Actions><SkeletonButton width={120} /></Actions>
        <Section first>
          <SkeletonHeading kicker width={160} />
          <SkeletonTable
            columns={[{ flex: 1.5 }, { flex: 1.3 }, { flex: 1 }, { flex: 1.8 }, { flex: 1.3 }]}
            rows={3}
            // Two lines in a cell: the kind and its detail.
            rowHeight={58}
          />
        </Section>
      </Stack>
    </Skeleton>
  );
}

/**
 * P12 Sales data: the coverage lead and Upload, the daily chart (its text line on native, D21) with its summary and
 * “Show the numbers”, By month, and Uploads and files.
 */
export function SalesSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="sales" label={props.label}>
      <Columns
        main={(
          <Stack>
            <SkeletonText type="sub" lines={2} />
            <Actions><SkeletonButton width={200} /></Actions>
          </Stack>
        )}
      />
      <Section>
        <SkeletonHeading kicker width={220} />
        <Columns
          main={(
            <Stack gap={12}>
              {Platform.OS === 'web' ? <SalesChartSkeleton /> : <SkeletonText width="60%" />}
              <SkeletonText lines={2} />
              <SkeletonButton link width={150} />
            </Stack>
          )}
        />
      </Section>
      <Section>
        <SkeletonHeading kicker width={140} />
        <Columns
          main={(
            <Stack>
              {Platform.OS === 'web' ? <SkeletonChart height={340} /> : null}
              <SkeletonTable columns={[{ flex: 1.4 }, { numeric: true }, { numeric: true }, { numeric: true }]} rows={6} stack={false} />
              <SkeletonText width="80%" />
            </Stack>
          )}
        />
      </Section>
      <Section>
        <SkeletonHeading width={200} />
        <Stack>
          <SkeletonText lines={2} />
          <Actions><SkeletonButton link width={120} /></Actions>
        </Stack>
      </Section>
    </Skeleton>
  );
}

/** The daily chart on web (SalesChart.web): its legend, the 196px frame beside the scale, the months and the scale line. */
function SalesChartSkeleton(): React.JSX.Element {
  return (
    <View style={styles.chart}>
      <SkeletonText type="mono" width={120} />
      <View style={styles.chartFrame}><SkeletonChart height={196} /></View>
      <View style={styles.chartFrame}><SkeletonText type="mono" /></View>
      <SkeletonText type="mono" width={200} />
    </View>
  );
}

/** P13 while the file is read: the Match columns step it opens on. */
export function UploadReadingSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="upload-reading" label={props.label}>
      <Stack gap={theme.space[6]} style={styles.read}>
        <Stack gap={theme.space[2]}>
          <SkeletonHeading width={200} />
          <SkeletonText lines={2} />
        </Stack>
        <Stack gap={theme.space[2]}>
          <SkeletonText type="ui" width={260} />
          <SkeletonBlock outline height={44} width={240} />
          <SkeletonBlock outline height={44} width={240} />
        </Stack>
        <SkeletonField helper />
        <Pair>
          <SkeletonField />
          <SkeletonField />
        </Pair>
        <Actions><SkeletonButton width={150} /><SkeletonButton link width={60} /><SkeletonButton link width={70} /></Actions>
      </Stack>
    </Skeleton>
  );
}

/** P13 while the days are sent: the result it opens on, its message lines and the Calibration panel. */
export function UploadSendingSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="upload-sending" label={props.label}>
      <Stack gap={theme.space[6]}>
        <View style={styles.messages}>
          {[0, 1].map((item) => (
            <View key={item} style={styles.message}><SkeletonText type="sub" width="70%" /></View>
          ))}
        </View>
        <SkeletonPanel>
          <SkeletonHeading kicker width={220} />
          <SkeletonText type="body" lines={2} />
          <SkeletonDefinitions rows={7} />
        </SkeletonPanel>
        <Actions><SkeletonButton width={160} /><SkeletonButton link width={100} /></Actions>
      </Stack>
    </Skeleton>
  );
}

/**
 * P3 Request access while it asks whether the Google Places search is on: Step 1, the search with its helper and
 * “Can’t find it?”, then Step 2's fields and Send request.
 */
export function RequestAccessSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="request-access" label={props.label}>
      <Stack gap={20}>
        <SkeletonHeading kicker width={240} />
        <SkeletonField helper />
        <Actions><SkeletonButton link width={260} /></Actions>
        <SkeletonHeading kicker width={160} />
        <SkeletonField helper />
        <Pair>
          <SkeletonField />
          <SkeletonField helper />
        </Pair>
        <Pair>
          <SkeletonField />
        </Pair>
        <SkeletonField helper height={132} />
        <Actions><SkeletonButton width={150} /></Actions>
      </Stack>
    </Skeleton>
  );
}

/** P7 Two-step sign-in while it reads whether two-step is on: the Before you start panel. */
export function SecuritySkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="security" label={props.label}>
      <SkeletonPanel>
        <SkeletonHeading width={200} />
        <SkeletonText lines={2} />
        <Actions><SkeletonButton width={220} /></Actions>
      </SkeletonPanel>
    </Skeleton>
  );
}

const WEEKS = 6;
const DAYS = 7;

/** A month as a grid of `WEEKS` rows of seven cells of a fixed height under a weekday head: always 42 cells, so the grid never changes height. */
function SkeletonMonth(props: { cellTestID: string; cellHeight: number }): React.JSX.Element {
  return (
    <View style={styles.month}>
      <View style={styles.monthRow}>
        {Array.from({ length: DAYS }, (_, day) => (
          <View key={day} style={styles.monthHead}><SkeletonText type="mono" width="60%" /></View>
        ))}
      </View>
      {Array.from({ length: WEEKS }, (_, week) => (
        <View key={week} style={styles.monthRow}>
          {Array.from({ length: DAYS }, (_, day) => (
            <View key={day} testID={props.cellTestID} style={[styles.monthCell, { height: props.cellHeight }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** This week's strip (home/ThisWeek.tsx): its 124px column of row labels. */
const WEEK_CORNER = 124;

/**
 * Home's month cells (home/MonthGrid): 96px tall once a cell, a seventh of the grid's column less its 3px gaps, is
 * `WIDE_CELL` wide; else at least 64px on web from 641px, and 52px on phones and native.
 */
function homeCellHeight(width: number, phone: boolean): number {
  if ((width - 6 * 3) / 7 >= WIDE_CELL) return WIDE_CELL_HEIGHT;
  return Platform.OS === 'web' && !phone ? 64 : 52;
}

/**
 * A Block's head (home/Block.tsx): the eyebrow over the h2. A title known before the page loads is drawn in its own
 * words (`words`), so it takes the lines it will take; one with the town's or month's name is a bar of `width`.
 */
function BlockHeadSkeleton(props: { eyebrow?: number; words?: string; width?: number }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View style={styles.blockHead}>
      <SkeletonText type="label" width={props.eyebrow ?? 140} />
      {props.words === undefined
        ? <SkeletonHeading width={props.width ?? 240} />
        : <Text style={phone ? theme.type.h3Phone : theme.type.h3}><SkeletonWords>{props.words}</SkeletonWords></Text>}
    </View>
  );
}

/** One of At a glance's tiles (home/Glance.tsx Tile): the eyebrow, then the tile's own shapes 12px apart. */
function GlanceTileSkeleton(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Panel style={styles.tile}>
      <SkeletonText type="label" width={150} />
      {props.children}
    </Panel>
  );
}

/** A tile's lines of small text, 2px apart (Glance.tsx `lines`). */
function TileLines(props: { widths: readonly DimensionValue[] }): React.JSX.Element {
  return <View style={styles.tileLines}>{props.widths.map((width, index) => <SkeletonText key={index} width={width} />)}</View>;
}

/**
 * Lines Home's skeleton draws invisibly (`SkeletonWords`) from the page's own templates, so they wrap where the page's
 * lines do at any width. Their figures, dates and town are placeholders of a usual length, so each is masked: every
 * letter and digit an `s`, punctuation and spaces kept, so a skeleton's DOM never holds a figure or a claim the page
 * hasn't made (find in page, copy, the honesty tests), only the shape of the words. `s` because, measured at 14px
 * Instrument Sans (2026-11-18), it runs 3 to 11% narrower than the tile's real lines, which their bold figures widen
 * back; `n` ran 7 to 19% wider and wrapped the tile three lines early. In mono every glyph is one width.
 */
const masked = (words: string): string => words.replace(/[\p{L}\p{N}]/gu, 's');
/**
 * `masked` for a line of plain text, without the bold figures that widen the tile's: `x`, which the font's own advance
 * widths (Instrument Sans at 14px, 2026-11-18) put at 99 to 105% of Who's in town's and Past years' real lines, where
 * `s` came to 86 to 91% and so wrapped a line short at 1280, 1100 and 375.
 */
const maskedPlain = (words: string): string => words.replace(/[\p{L}\p{N}]/gu, 'x');
const PLACEHOLDER_TOWN = { townId: 'town', name: 'Hanover', state: 'NH' };
const PLACEHOLDER_WEEK = { from: '2026-11-18', to: '2026-11-24' };

/**
 * This week's forecast tile's six lines (Glance.tsx ForecastWeekTile): range, days, today, busiest, quietest, last year.
 * The last-year line is drawn from 6 of its 7 days, with its "From 6 of its 7 days." ending, as the owner's location's
 * is (a closed day last year); a complete week's line is that much shorter.
 */
const WEEK_TILE_WORDS: readonly string[] = [
  plainOf(weekRangePhrase({ low: 600, high: 900 })),
  weekForecastLabel({ ...PLACEHOLDER_WEEK, missing: [] }),
  // todayForecastPhrase's open day.
  `Today: ${markedFigure('110 guests', { kind: 'forecast' })}, ${FORECAST_TAG}, 90 to 130.`,
  plainOf(forecastDayPhrase('Busiest', { date: '2026-11-21', value: 220, booked: false })),
  plainOf(forecastDayPhrase('Quietest', { date: '2026-11-23', value: 60, booked: false })),
  plainOf(lastYearBesidePhrase({
    ...PLACEHOLDER_WEEK, days: 6, total: 757, vsUsual: { change: -0.19, days: 7 }, busiest: null, quietest: null, busiestValue: null, quietestValue: null,
  }, 'guests')),
];

/** This week's footnote on the town calendar's coverage (ThisWeek.tsx, analytics/week.ts calendarCoverageLine). */
const COVERAGE_WORDS = calendarCoverageLine({ town: PLACEHOLDER_TOWN, researched: true, covers: { from: '2026-09-01', to: '2027-06-30' } });

/** This week's calendar line and a term's line (analytics/week.ts calendarWeekLine, periodLine). */
const WEEK_LINE_WORDS = 'On the calendar this week: Home football vs Brown (Saturday).';
const WEEK_PERIOD_WORDS = 'Fall term finals. Term, Nov 20 to 25, 2026.';

/** A day's forecast in This week's strip (analytics/week.ts forecastPhrase, an open day). */
const STRIP_FORECAST_WORDS = `${markedFigure('110 guests', { kind: 'forecast' })}, ${FORECAST_TAG}, likely 90 to 130`;
/** A day last year in the strip (ThisWeek.tsx PastCell): the day and its figure, then its change against the usual. */
const STRIP_PAST_WORDS = ['Sat, Nov 22, 2025: 241 guests', '+4% vs usual'] as const;

/** The month key's labels after its two figure samples (MonthKey.tsx, calendar/FigureKey.tsx). */
const KEY_LABELS = [FIGURE_KEY.actual, FIGURE_KEY.forecast, 'Town event or holiday', 'Your note or rule', 'Your calendar', 'Today', 'This week', 'Selected day'];

/** One past year's line (ThisMonth.tsx PastYears, analytics/week.ts monthFactLine). */
const PAST_YEAR_WORDS = monthFactLine({ year: 2025, days: 30, yearDays: 340, mean: 118, change: 0.12 }, 'guests');

/**
 * This week's forecast tile under its eyebrow (Glance.tsx ForecastWeekTile): the 40px figure with its unit beside it
 * (under it when the tile is narrow), then its six lines in their own words, 2px apart. Home's skeleton and the
 * tile's own, while the forecast loads, both draw it.
 */
export function WeekTileShapes(): React.JSX.Element {
  return (
    <View style={styles.tileBody}>
      <View style={styles.tileFigure}>
        <SkeletonFigure compact width={140} />
        <SkeletonWords type="mono">{masked(`guests, ${FORECAST_TAG}`)}</SkeletonWords>
      </View>
      <View style={styles.tileLines}>
        {WEEK_TILE_WORDS.map((words, index) => <SkeletonWords key={index} type="small">{masked(words)}</SkeletonWords>)}
      </View>
    </View>
  );
}

/**
 * This week from 1024px (ThisWeek.tsx WeekStrip): the seven days' heads (today's with its Today line) over the rows a
 * location with history and a published forecast shows, each ruled and labeled in the 124px column: Forecast (its
 * figure and range, three mono lines in a seventh), On the calendar (an entry's title over its kind) and Last year
 * (the 40px bar zone over the day's figure and its usual).
 */
function WeekStripSkeleton(): React.JSX.Element {
  const rows: { key: string; cell: React.ReactNode }[] = [
    { key: 'forecast', cell: <SkeletonWords type="mono">{masked(STRIP_FORECAST_WORDS)}</SkeletonWords> },
    { key: 'calendar', cell: <View><SkeletonText type="ui" lines={2} width="90%" lastWidth="60%" /><SkeletonText type="mono" width="50%" /></View> },
    {
      key: 'lastYear',
      cell: (
        <View style={styles.weekCellBody}>
          <SkeletonBlock height={40} />
          <View>{STRIP_PAST_WORDS.map((words) => <SkeletonWords key={words} type="mono">{masked(words)}</SkeletonWords>)}</View>
        </View>
      ),
    },
  ];
  return (
    <View style={styles.weekStrip}>
      <View style={styles.weekRow}>
        <View style={styles.weekCorner} />
        {Array.from({ length: DAYS }, (_, day) => (
          <View key={day} style={styles.weekCell}>
            <SkeletonText type="ui" width={32} />
            <SkeletonText type="mono" width={48} />
            {day === 0 ? <SkeletonText type="mono" width={40} /> : null}
          </View>
        ))}
      </View>
      {rows.map((row) => (
        <View key={row.key} style={[styles.weekRow, styles.weekRuled]}>
          <View style={styles.weekCorner}><SkeletonText type="mono" width={80} /></View>
          {Array.from({ length: DAYS }, (_, day) => <View key={day} style={styles.weekCell}>{row.cell}</View>)}
        </View>
      ))}
    </View>
  );
}

/** This month's key (MonthKey.tsx): its items wrapping, each a 12px swatch (a figure sample for the first two) and its label. */
function MonthKeySkeleton(): React.JSX.Element {
  return (
    <View style={styles.monthKey}>
      {KEY_LABELS.map((label, index) => (
        <View key={label} style={styles.monthKeyItem}>
          {index < 2 ? <SkeletonWords type="mono">{masked(index === 0 ? '94' : '~82')}</SkeletonWords> : <SkeletonBlock height={12} width={12} />}
          <SkeletonWords type="mono">{masked(label)}</SkeletonWords>
        </View>
      ))}
    </View>
  );
}

/** A source chip's 44px target around its 24px pill (ui/SourceChip.tsx). */
function ChipSkeleton(): React.JSX.Element {
  return <View style={styles.chip}><SkeletonBlock height={24} width={140} /></View>;
}

/** One of Who's in town's runs (InTown.tsx Rows): its dates (mono, 112px) beside its words, over them on a phone. */
function TownRunSkeleton(): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View style={phone ? styles.townRunPhone : styles.townRun}>
      <View style={phone ? null : styles.townRunWhen}><SkeletonText type="mono" width={88} /></View>
      <View style={styles.townRunWords}><SkeletonText width={120} /></View>
    </View>
  );
}

/**
 * Who's in town's lines that wrap (home/InTown.tsx), in the page's wording with a placeholder town, day and figures, all
 * masked: the no-number line, today's term (nowLine), the between-terms note, Your sales by term (estimates/format.ts
 * historyLine) and its provenance (estimates/Provenance.tsx), and the county's jobs (jobsWords, as figure and rest).
 */
const TOWN_WORDS = {
  noNumber: noNumberLine(PLACEHOLDER_TOWN),
  now: 'Townwise has no term dates until Thu, Nov 19.',
  between: 'Between terms is worked out from the term dates.',
  history: 'Your Wednesdays averaged 112 guests in term and 115 between terms (53 and 14 Wednesdays).',
  provenance: 'From your sales, Jan 6, 2025 to Oct 21, 2026, 476 days.',
  jobs: ['4.5% fewer', ' jobs in November 2025 than in an average month that year.'],
  jobsNote: 'County, not town. Employment is a stand-in for demand.',
} as const;

/**
 * Who's in town's people (home/InTown.tsx People) for a college town with no headcount, as the owner's is: the Planned
 * tag with its no-number line (beside the tag when it fits, under it when not); This week (today's term as an h3 line,
 * then a run); Later in the month (a run); the between-terms note over a source chip; and Your sales by term over its
 * provenance. Its sentences are drawn in their words (`TOWN_WORDS`), so they wrap where the page's do. Home's skeleton
 * and the block's own, while its read is out, both draw it.
 */
export function InTownPeopleShapes(): React.JSX.Element {
  const { phone } = useBreakpoint();
  const group = (label: number, body: React.ReactNode): React.JSX.Element => (
    <View style={styles.inTownGroup}><SkeletonText type="label" width={label} />{body}</View>
  );
  return (
    <View style={styles.inTown}>
      <View style={styles.townTagRow}>
        <View style={styles.townTag}><SkeletonBlock outline height={6} width={6} /><SkeletonText type="label" width={54} /></View>
        <View style={styles.townShrink}><SkeletonWords type="small">{maskedPlain(TOWN_WORDS.noNumber)}</SkeletonWords></View>
      </View>
      {group(72, (
        <>
          <Text style={phone ? theme.type.h3Phone : theme.type.h3}><SkeletonWords>{maskedPlain(TOWN_WORDS.now)}</SkeletonWords></Text>
          <TownRunSkeleton />
        </>
      ))}
      {group(120, <TownRunSkeleton />)}
      <View style={styles.townFoot}><SkeletonWords type="mono">{masked(TOWN_WORDS.between)}</SkeletonWords><ChipSkeleton /></View>
      {group(130, (
        <>
          <SkeletonWords type="small">{maskedPlain(TOWN_WORDS.history)}</SkeletonWords>
          <SkeletonWords type="mono">{masked(TOWN_WORDS.provenance)}</SkeletonWords>
        </>
      ))}
    </View>
  );
}

/** The county's jobs (InTown.tsx Jobs): its figure line (24px, the figure 18px mono) and note, then the source chip. */
function JobsSkeleton(): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View style={styles.inTownGroup}>
      <SkeletonText type="label" width={220} />
      <Text style={[phone ? theme.type.sub : theme.type.small, styles.jobsLine]}>
        <Text style={styles.jobsFigure}><SkeletonWords>{masked(TOWN_WORDS.jobs[0])}</SkeletonWords></Text>
        <SkeletonWords>{masked(TOWN_WORDS.jobs[1])}</SkeletonWords>
      </Text>
      <SkeletonWords type="mono">{masked(TOWN_WORDS.jobsNote)}</SkeletonWords>
      <ChipSkeleton />
    </View>
  );
}

/**
 * The selected day beside the month (home/DayDetail.tsx), today at first: its h3, then Forecast, Why, Reorder, On the
 * calendar, This day and Same weekday last year.
 */
function DayDetailSkeleton(): React.JSX.Element {
  const part = (label: number, body: React.ReactNode): React.JSX.Element => (
    <View style={styles.dayPart}><SkeletonText type="mono" width={label} />{body}</View>
  );
  return (
    <View style={styles.dayDetail}>
      <SkeletonHeading width={160} />
      {part(64, <SkeletonText width="80%" />)}
      {part(32, <SkeletonText lines={2} lastWidth="70%" />)}
      {part(56, <><SkeletonText width="80%" /><SkeletonButton link width={200} /><SkeletonButton link width={160} /></>)}
      {part(112, <SkeletonText width="70%" />)}
      {part(64, <SkeletonText type="mono" width="60%" />)}
      {part(160, <SkeletonText type="mono" lines={2} width="70%" lastWidth="50%" />)}
    </View>
  );
}

/**
 * P11 Home, block for block as Home.tsx lays it out in its 12-column rows (home/Block.tsx), for a location with
 * history and a published forecast (the owner's choice, 2026-11-18): the lead line with Ask TownwiseAI; At a glance's
 * three tiles (the week's forecast, last week's figure, the next event's title); This week (its calendar line, the
 * strip from 1024px or the day table below it, the footnotes and Show the numbers); This month's grid with the key,
 * Open the calendar and the month's check line, beside the selected day; Last week on a line of its own (as with last
 * week's forecast; on web the chart with its day labels, legend and scale); On the calendar beside Who's in town (its
 * people's groups, then the county's jobs); Past years beside Bar order (which checks the next order
 * on its own, with no title yet); and Your history (its year's heatmap on web) with its links. Fixed copy (block
 * titles, footnotes, the month's first line) is drawn in its own words, so it wraps where the page's does.
 */
export function HomeSkeleton(props: LabelProps): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const web = Platform.OS === 'web';
  // The grid's column, measured as ThisMonth measures it, so the cells are the height the loaded grid's will be.
  const [gridWidth, setGridWidth] = useState(0);
  return (
    <Skeleton name="home" label={props.label}>
      <View style={styles.page}>
        <View style={[styles.lead, desktop ? styles.leadWide : null]}>
          <View style={styles.leadText}><SkeletonText type="mono" lines={phone ? 2 : 1} width="70%" lastWidth="40%" /></View>
          <Actions><SkeletonButton width={170} /></Actions>
        </View>
        <BlockRow
          tablet
          items={[
            { key: 'week', span: 4, node: <GlanceTileSkeleton><WeekTileShapes /></GlanceTileSkeleton> },
            { key: 'last', span: 4, node: <GlanceTileSkeleton><SkeletonFigure compact width={160} /><TileLines widths={['90%', '70%']} /></GlanceTileSkeleton> },
            {
              key: 'next', span: 4,
              node: (
                <GlanceTileSkeleton>
                  <View style={styles.tileTitle}><View style={styles.tileTitleBar} /></View>
                  <TileLines widths={['60%', '40%']} />
                </GlanceTileSkeleton>
              ),
            },
          ]}
        />
        <SkeletonPanel>
          <BlockHeadSkeleton eyebrow={180} words="What’s on the calendar, and how this week went before" />
          {/* The week's calendar line, then a college town's term this week over its source chip (ThisWeek.tsx). */}
          <View style={styles.weekLines}>
            <SkeletonWords type="small">{masked(WEEK_LINE_WORDS)}</SkeletonWords>
            <View style={styles.weekPeriod}><SkeletonWords type="small">{masked(WEEK_PERIOD_WORDS)}</SkeletonWords><ChipSkeleton /></View>
          </View>
          {desktop ? <WeekStripSkeleton /> : (
            // A day's weekday and date; its forecast; an entry's title over its kind; last year's figure over its change. The
            // rows are 64px from 641px, as tall as a day's head with a two-line cell beside it (today's, with Today, is 70).
            <SkeletonTable columns={[{ flex: 0.8, lines: 2 }, { flex: 1.4 }, { flex: 2, lines: 2 }, { flex: 1.6, lines: 2 }]} rows={DAYS} rowHeight={64} />
          )}
          <View style={styles.footnotes}>
            <SkeletonWords type="mono">{LAST_YEAR_FOOTNOTE}</SkeletonWords>
            {desktop ? <SkeletonWords type="mono">{BARS_FOOTNOTE}</SkeletonWords> : null}
            <SkeletonWords type="mono">{masked(COVERAGE_WORDS)}</SkeletonWords>
          </View>
          <SkeletonButton link width={150} />
        </SkeletonPanel>
        <BlockRow
          items={[
            {
              key: 'month', span: 12,
              node: (
                <SkeletonPanel>
                  <BlockHeadSkeleton eyebrow={110} width={260} />
                  <SkeletonWords type="small">{MONTH_INTRO}</SkeletonWords>
                  <View style={styles.split}>
                    <View style={styles.gridSide} onLayout={(event: LayoutChangeEvent) => { setGridWidth(event.nativeEvent.layout.width); }}>
                      <SkeletonMonth cellTestID="skeleton-home-month-cell" cellHeight={homeCellHeight(gridWidth, phone)} />
                      <MonthKeySkeleton />
                      <SkeletonButton link width={130} />
                      {/* The month's check line (calendar/model.ts monthCheckLine): two lines on phones. */}
                      <SkeletonText lines={phone ? 2 : 1} width="70%" lastWidth="40%" />
                    </View>
                    <View style={styles.detailSide}><DayDetailSkeleton /></View>
                  </View>
                </SkeletonPanel>
              ),
            },
            {
              key: 'last', span: 12,
              node: (
                <SkeletonPanel>
                  <BlockHeadSkeleton eyebrow={200} words="Against the same week last year" />
                  {web ? (
                    // LastWeekChart.web.tsx: the 120px chart, its day labels, its legend (two lines on phones) and its scale, 8px apart.
                    <View style={styles.footnotes}>
                      <SkeletonChart height={120} />
                      <SkeletonText type="mono" />
                      <SkeletonText type="mono" lines={phone ? 2 : 1} width="60%" lastWidth="30%" />
                      <SkeletonText type="mono" width="50%" />
                    </View>
                  ) : null}
                  <SkeletonText lines={2} lastWidth="50%" />
                  <SkeletonButton link width={150} />
                </SkeletonPanel>
              ),
            },
          ]}
        />
        <BlockRow
          items={[
            {
              key: 'list', span: 6,
              node: (
                <SkeletonPanel>
                  <BlockHeadSkeleton eyebrow={110} width={280} />
                  <View style={styles.monthList}>
                    {[0, 1, 2, 3].map((item) => (
                      <View key={item} style={phone ? styles.monthItemPhone : styles.monthItem}>
                        <View style={phone ? null : styles.monthItemDate}><SkeletonText type="ui" width={80} /></View>
                        <View style={styles.monthItemBody}><SkeletonText width="80%" /><ChipSkeleton /></View>
                      </View>
                    ))}
                  </View>
                </SkeletonPanel>
              ),
            },
            {
              key: 'people', span: 6,
              node: (
                <SkeletonPanel>
                  <BlockHeadSkeleton eyebrow={160} words="Who’s in town" />
                  <View style={styles.inTown}>
                    <InTownPeopleShapes />
                    <JobsSkeleton />
                  </View>
                </SkeletonPanel>
              ),
            },
          ]}
        />
        <BlockRow
          items={[
            {
              key: 'years', span: 6,
              node: (
                <SkeletonPanel>
                  <BlockHeadSkeleton eyebrow={120} width={280} />
                  <SkeletonWords type="small">{maskedPlain(PAST_YEAR_WORDS)}</SkeletonWords>
                  <SkeletonWords type="mono">Averages leave out closed days.</SkeletonWords>
                </SkeletonPanel>
              ),
            },
            {
              key: 'bar', span: 6,
              node: (
                <SkeletonPanel>
                  <SkeletonText type="label" width={80} />
                  <SkeletonText width="50%" />
                  <SkeletonText width="80%" />
                  <SkeletonButton link width={100} />
                </SkeletonPanel>
              ),
            },
          ]}
        />
        <SkeletonPanel>
          <BlockHeadSkeleton eyebrow={110} width={120} />
          {/* Its dates, missing days and last upload: one line from 641px, three on phones. */}
          <SkeletonText lines={phone ? 3 : 1} width="90%" lastWidth="50%" />
          {web ? <SkeletonYearGrid testID="skeleton-home-heatmap" year /> : null}
          <Actions><SkeletonButton link width={150} /><SkeletonButton link width={110} /></Actions>
        </SkeletonPanel>
      </View>
    </Skeleton>
  );
}

/**
 * P28 Calendar: the header row (Today, the two arrows, the label's 216px, flexible at 640px and below as the page's
 * is, the Month and Week switch's 130px and the "Your calendars" button's 170px, as the row's own items, so it wraps
 * where the page's does: one line at 1024px, two at 375px; the button's panel is closed on load), the filters' legend over four chips where the page puts
 * them for the width (heading the grid's column from 641px, so from 1024px the panel beside it starts level with the
 * legend; after the grid below), then the month's grid, always six weeks of seven days, each cell as tall as the
 * loaded grid's (grid.ts cellSize), with the day panel beside it from 1024px and under it below.
 */
export function CalendarSkeleton(props: LabelProps): React.JSX.Element {
  const { desktop, phone, width } = useBreakpoint();
  const filters = (
    <View testID="skeleton-calendar-filters" style={styles.calendarFilters}>
      <SkeletonText type="ui" width={140} />
      <View style={styles.chips}>
        {[88, 96, 80, 104].map((chip) => <SkeletonButton key={chip} width={chip} />)}
      </View>
    </View>
  );
  return (
    <Skeleton name="calendar" label={props.label}>
      <View style={styles.calendar}>
        <View testID="skeleton-calendar-row" style={[styles.calendarRow, desktop ? styles.calendarRowWide : null]}>
          <View style={[styles.switcher, desktop ? styles.switcherWide : styles.switcherNarrow, phone ? styles.switcherPhone : null]}>
            <SkeletonButton link width={44} />
            <SkeletonButton width={44} />
            <SkeletonButton width={44} />
            <View testID="skeleton-calendar-label" style={phone ? styles.calendarLabelPhone : styles.calendarLabel}>
              <SkeletonBlock height={theme.type.ui.fontSize} width={128} />
            </View>
          </View>
          {/* The Month and Week switch, then "Your calendars", each about as wide as the page's, on web and native; its
              panel is closed on load, so nothing stands for it. */}
          <View testID="skeleton-calendar-views"><SkeletonButton width={130} /></View>
          <SkeletonButton testID="skeleton-calendar-calendars" width={170} />
        </View>
        <View style={desktop ? styles.split : styles.stacked}>
          <View style={[styles.calendarColumn, desktop ? styles.wide : null]}>
            {phone ? null : filters}
            <SkeletonMonth cellTestID="skeleton-calendar-cell" cellHeight={cellSize(width).height} />
          </View>
          {phone ? filters : null}
          <View testID="skeleton-calendar-panel" style={desktop ? styles.narrow : null}>
            <Stack gap={theme.space[5]}>
              <SkeletonHeading width={200} />
              <SkeletonText type="sub" lines={2} />
              <SkeletonDefinitions rows={3} />
              <SkeletonText lines={3} />
              <Actions><SkeletonButton width={140} /></Actions>
            </Stack>
          </View>
        </View>
      </View>
    </Skeleton>
  );
}

/**
 * P29 Business rules: the add form (New rule with its helper, Change the forecast's outline button over its helper line,
 * Add rule) and a few rule rows under their head.
 */
export function RulesSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="rules" label={props.label}>
      <Stack gap={32}>
        <Columns
          main={(
            <Stack>
              <SkeletonField helper />
              <Stack gap={8}>
                <Actions><View testID="skeleton-rules-schedule-button"><SkeletonButton width={170} /></View></Actions>
                <View testID="skeleton-rules-schedule-help"><SkeletonText width="90%" /></View>
              </Stack>
              <Actions><SkeletonButton width={120} /></Actions>
            </Stack>
          )}
        />
        <Section first>
          <SkeletonHeading kicker width={80} />
          <SkeletonHeading width={120} />
          <View style={styles.rules}>
            {[0, 1, 2].map((row) => (
              <View key={row} testID="skeleton-rules-row" style={styles.rule}>
                <SkeletonText type="sub" width="50%" />
                <SkeletonText type="ui" width="70%" />
                <SkeletonText type="ui" width="60%" />
                <Actions><SkeletonButton link width={40} /><SkeletonButton link width={56} /></Actions>
              </View>
            ))}
          </View>
        </Section>
      </Stack>
    </Skeleton>
  );
}

/** The heatmap's left column (Mon, Wed, Fri) and its gaps, as Heatmap.web.tsx draws them. */
const HEATMAP_HEAD = 40;
const HEATMAP_GAP = 3;
/** The web charts' frame, beside their 72px scale (AnalyticsCharts.web.tsx). */
const CHART_HEIGHT = 160;
/** By type of night's 12px bars, one per type, at made-up lengths (no sample values). */
const NIGHT_BARS = ['90%', '78%', '66%', '54%', '42%'] as const;

/**
 * Every day's heatmap on web: the month labels over one year's grid of 7 weekday rows by 53 week columns of square
 * cells (one block of that shape) beside its weekday labels. Native lists months instead: a 44px row each.
 */
function SkeletonHeatmap(): React.JSX.Element {
  if (Platform.OS !== 'web') {
    return (
      <View testID="skeleton-analytics-heatmap">
        {Array.from({ length: 6 }, (_, month) => (
          <View key={month} testID="skeleton-analytics-month" style={styles.monthListRow}>
            <SkeletonText type="ui" width={120} />
            <SkeletonText type="ui" width={140} />
          </View>
        ))}
      </View>
    );
  }
  return <SkeletonYearGrid testID="skeleton-analytics-heatmap" />;
}

/** The web heatmap's one year (Heatmap.web.tsx): the month labels over 7 weekday rows by 53 week columns of square cells, beside the weekday labels. */
function SkeletonYearGrid(props: { testID: string; year?: boolean }): React.JSX.Element {
  return (
    <View testID={props.testID} style={styles.heatmap}>
      {/* `year`: the year's label over its grid, as Home's history card shows it. */}
      {props.year === true ? <SkeletonText type="mono" width={32} /> : null}
      <View style={styles.heatmapMonths}><SkeletonText type="mono" /></View>
      <View style={styles.heatmapRow}>
        <View style={styles.heatmapDays}>
          {[0, 1, 2].map((day) => <SkeletonText key={day} type="mono" width={24} />)}
        </View>
        <View style={styles.heatmapGrid} />
      </View>
    </View>
  );
}

/** A chart section in the reading column: its summary, the chart (web only, D21), the basis line and Show the numbers. */
function SkeletonChartSection(props: { children?: React.ReactNode; summary?: number }): React.JSX.Element {
  return (
    <Section>
      <SkeletonHeading width={180} />
      <Columns
        main={(
          <View style={styles.analyticsColumn}>
            <SkeletonText lines={props.summary ?? 1} width="80%" />
            {Platform.OS === 'web' ? props.children : null}
            <SkeletonText width="70%" />
            <SkeletonButton link width={150} />
          </View>
        )}
      />
    </Section>
  );
}

/** A web bar or line chart: the 160px frame beside its scale, then its axis labels. */
function AnalyticsChartSkeleton(): React.JSX.Element {
  return (
    <View testID="skeleton-analytics-chart" style={styles.chart}>
      <View style={styles.chartFrame}><SkeletonChart height={CHART_HEIGHT} /></View>
      <View style={styles.chartFrame}><SkeletonText type="mono" /></View>
    </View>
  );
}

/**
 * P24 Analytics: the lead, the filter block (Color by's two switches, then Show on the calendar, Include in the numbers
 * and Years, each a column of 44px boxes; a row from 1024px, stacked below), Every day (the heatmap with the Day panel
 * beside it, sticky, from 1024px and under it below; month rows on native), then the reading column's sections: Weekly
 * shape, By month and Year over year (160px charts on web), By type of night (its lines and bars) and Biggest drivers
 * (a table). Analytics.tsx mounts it while its three reads are out.
 */
export function AnalyticsSkeleton(props: LabelProps): React.JSX.Element {
  const { desktop } = useBreakpoint();
  const web = Platform.OS === 'web';
  const panel = (
    <View testID="skeleton-analytics-panel">
      <Stack gap={theme.space[5]}>
        <SkeletonHeading width={200} />
        <SkeletonDefinitions rows={4} />
        <SkeletonText lines={2} />
        <Actions><SkeletonButton link width={110} /><SkeletonButton link width={90} /></Actions>
      </Stack>
    </View>
  );
  return (
    <Skeleton name="analytics" label={props.label}>
      <SkeletonText type="sub" width={320} />
      <View testID="skeleton-analytics-filters" style={[styles.filters, desktop ? styles.filtersRow : null]}>
        <View testID="skeleton-analytics-filter-group" style={styles.filterGroup}>
          <SkeletonText type="ui" width={64} />
          <View style={styles.switches}><SkeletonButton width={84} /><SkeletonButton width={100} /></View>
        </View>
        {[4, 3, 3].map((boxes, group) => (
          <View key={group} testID="skeleton-analytics-filter-group" style={styles.filterGroup}>
            <SkeletonText type="ui" width={150} />
            {Array.from({ length: boxes }, (_, box) => (
              <View key={box} style={styles.checkRow}>
                <SkeletonBlock outline width={16} height={16} />
                <SkeletonText type="ui" width={110} />
              </View>
            ))}
          </View>
        ))}
      </View>
      <Section>
        <SkeletonHeading width={140} />
        {web ? (
          <View style={desktop ? styles.everyDay : styles.everyDayStacked}>
            <View style={desktop ? styles.wide : null}>
              <Stack gap={12}>
                <SkeletonHeatmap />
                {desktop ? null : panel}
                <SkeletonText width="80%" />
                <SkeletonButton link width={150} />
              </Stack>
            </View>
            {desktop ? <View style={styles.narrow}>{panel}</View> : null}
          </View>
        ) : (
          <Stack gap={12}>
            <SkeletonHeatmap />
            <SkeletonText lines={3} />
          </Stack>
        )}
      </Section>
      <SkeletonChartSection><AnalyticsChartSkeleton /></SkeletonChartSection>
      <SkeletonChartSection><AnalyticsChartSkeleton /></SkeletonChartSection>
      <SkeletonChartSection>
        <SkeletonText type="mono" width={240} />
        <AnalyticsChartSkeleton />
      </SkeletonChartSection>
      <SkeletonChartSection summary={4}>
        <View testID="skeleton-analytics-bars" style={styles.bars}>
          {NIGHT_BARS.map((width) => (
            <View key={width} style={styles.barRow}>
              <View style={styles.barLabel}><SkeletonText type="mono" width="80%" /></View>
              <View style={styles.barTrack}><SkeletonBlock height={12} width={width} /></View>
            </View>
          ))}
        </View>
      </SkeletonChartSection>
      <Section>
        <SkeletonHeading width={180} />
        <Columns
          main={(
            <View testID="skeleton-analytics-drivers" style={styles.analyticsColumn}>
              <SkeletonTable columns={[{ flex: 0.4 }, { flex: 1.6 }, ...(web ? [{ flex: 1.4 }] : []), { numeric: true }, { flex: 1.4 }]} rows={5} />
              <SkeletonText lines={2} />
            </View>
          )}
        />
      </Section>
    </Skeleton>
  );
}

const styles = StyleSheet.create({
  page: { gap: GUTTER },
  lead: { gap: theme.space[4], marginBottom: theme.space[4] },
  leadWide: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: theme.space.gutter },
  leadText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  split: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[6], rowGap: theme.space[5], alignItems: 'flex-start' },
  // P11 Home, in its blocks' own styles (home/*.tsx).
  blockHead: { gap: theme.space[2] },
  tile: { flexGrow: 1, gap: theme.space[3] },
  tileLines: { gap: 2 },
  tileBody: { gap: theme.space[3] },
  // Glance.tsx `figure`: the unit wraps under the figure in a narrow tile.
  tileFigure: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', columnGap: theme.space[2] },
  chip: { minHeight: 44, justifyContent: 'center' },
  // MonthKey.tsx `key` and `item`.
  monthKey: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6 },
  monthKeyItem: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  jobsLine: { lineHeight: 24 },
  jobsFigure: { ...theme.type.monoValue, fontSize: 18, lineHeight: 24 },
  // An event's title in `h3` (22/28) at every width.
  tileTitle: { height: theme.type.h3.lineHeight, justifyContent: 'center' },
  tileTitleBar: { height: theme.type.h3.fontSize, width: '70%', backgroundColor: c.raised },
  weekStrip: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border },
  weekRow: { flexDirection: 'row', alignItems: 'stretch' },
  weekRuled: { borderTopWidth: 1, borderTopColor: c.border },
  weekCorner: { width: WEEK_CORNER, paddingVertical: theme.space[3], paddingRight: theme.space[3] },
  weekCell: { flex: 1, minWidth: 0, paddingVertical: theme.space[3], paddingHorizontal: theme.space[2], borderLeftWidth: 1, borderLeftColor: c.border },
  weekCellBody: { gap: theme.space[2] },
  footnotes: { gap: 8 },
  // Side by side from a 720px content column (416 + 24 + 280): the grid grows 3 to the detail's 2 (ThisMonth.tsx).
  gridSide: { flexGrow: 3, flexShrink: 1, flexBasis: 416, minWidth: 0, gap: theme.space[3] },
  detailSide: { flexGrow: 2, flexShrink: 1, flexBasis: 280, minWidth: 0 },
  dayDetail: { gap: theme.space[4], minWidth: 0 },
  dayPart: { gap: theme.space[1], minWidth: 0 },
  monthList: { gap: theme.space[3] },
  monthItem: { flexDirection: 'row', columnGap: theme.space[4], alignItems: 'flex-start' },
  monthItemPhone: { gap: 2 },
  monthItemDate: { width: 112 },
  monthItemBody: { flex: 1, minWidth: 0 },
  inTown: { gap: theme.space[5], minWidth: 0 },
  // InTown.tsx's group, row and tag (ui/feedback.tsx StatusTag: its label line, 3px padding and 1px border).
  inTownGroup: { gap: theme.space[3], paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border, minWidth: 0 },
  townTagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[3], rowGap: theme.space[2] },
  townTag: { flexDirection: 'row', alignItems: 'center', columnGap: 6, borderWidth: 1, borderColor: c.line, paddingVertical: 3, paddingHorizontal: 6 },
  townRun: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[4], minWidth: 0 },
  townRunPhone: { gap: 2, minWidth: 0 },
  townRunWhen: { width: 112 },
  townRunWords: { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 0 },
  townShrink: { flexShrink: 1, minWidth: 0 },
  // ThisWeek.tsx's Stack of 8 and its term item's 2.
  weekLines: { gap: theme.space[2] },
  weekPeriod: { gap: 2, minWidth: 0 },
  townFoot: { alignItems: 'flex-start' },
  month: { gap: 3, width: '100%' },
  monthRow: { flexDirection: 'row', gap: 3 },
  monthHead: { flex: 1, alignItems: 'center' },
  monthCell: { flex: 1, minWidth: 0, backgroundColor: c.raised },
  // P28 Calendar, as calendar/Toolbar.tsx and CalendarPage.tsx lay it out.
  calendar: { gap: theme.space[6] },
  calendarRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[3], rowGap: theme.space[4] },
  calendarRowWide: { justifyContent: 'flex-end' },
  switcher: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3], minHeight: 44 },
  switcherWide: { marginRight: 'auto' },
  switcherNarrow: { flexBasis: '100%' },
  switcherPhone: { flexShrink: 1, minWidth: 0 },
  calendarLabel: { width: 216 },
  calendarLabelPhone: { flexShrink: 1, minWidth: 0 },
  calendarFilters: { gap: theme.space[2] },
  calendarColumn: { gap: theme.space[4] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[2], rowGap: theme.space[2] },
  stacked: { gap: theme.space[8] },
  wide: { flex: 8, minWidth: 0 },
  narrow: { flex: 4, minWidth: 0 },
  rules: { borderTopWidth: 1, borderTopColor: c.border, maxWidth: 720 },
  rule: { gap: theme.space[1], paddingVertical: theme.space[4], borderBottomWidth: 1, borderBottomColor: c.border },
  towns: { gap: theme.space[5] },
  townsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  town: { flexGrow: 1, flexBasis: 320 },
  measure: { maxWidth: 680 },
  chart: { gap: 8 },
  // The chart's scale labels sit in the 72px to its left.
  chartFrame: { marginLeft: 72 },
  read: { maxWidth: 760 },
  messages: { borderTopWidth: 1, borderTopColor: c.border, maxWidth: 640 },
  message: { paddingVertical: 14, paddingLeft: 36, borderBottomWidth: 1, borderBottomColor: c.border },
  // Analytics (Analytics.tsx, FilterPanel.tsx, MetricSwitch.tsx, Heatmap.web.tsx, AnalyticsCharts.web.tsx).
  filters: { marginTop: theme.space[6], gap: theme.space[5] },
  filtersRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: theme.space[10], rowGap: theme.space[5] },
  filterGroup: { gap: theme.space[1], minWidth: 0 },
  switches: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2], marginTop: theme.space[1] },
  checkRow: { flexDirection: 'row', alignItems: 'center', columnGap: 10, minHeight: 44 },
  everyDay: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  everyDayStacked: { gap: theme.space[6] },
  heatmap: { gap: 6 },
  heatmapMonths: { marginLeft: HEATMAP_HEAD + HEATMAP_GAP },
  heatmapRow: { flexDirection: 'row', columnGap: HEATMAP_GAP },
  heatmapDays: { width: HEATMAP_HEAD, justifyContent: 'space-around' },
  // Seven rows of square cells by 53 columns: about 53 to 7 across the grid's width.
  heatmapGrid: { flex: 1, minWidth: 0, aspectRatio: 53 / 7, backgroundColor: c.raised },
  monthListRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12, minHeight: 44,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  analyticsColumn: { gap: theme.space[5] },
  bars: { gap: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', columnGap: 12 },
  barLabel: { width: 140 },
  barTrack: { flex: 1, minWidth: 0 },
});
