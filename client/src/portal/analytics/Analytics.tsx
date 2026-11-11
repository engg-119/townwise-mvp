import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';

import { theme } from '../../theme';
import { ModelCard } from '../estimates/ModelCard';
import { formatCount, formatDate, plural } from '../format';
import { useBreakpoint, useLoad } from '../hooks';
import { addDays, formatMonth, localToday, monthRange } from '../locations/dates';
import { fetchNotes, type Note } from '../locations/api';
import { LoadFailure, Loading, ShowNumbers, UploadAction } from '../locations/parts';
import { UPLOADS_OFF_LINE } from '../locations/sales';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { EmptyState, ReadOnlyLine, StatusTag } from '../ui/feedback';
import { Columns, Section, Stack } from '../ui/layout';
import { Lead, Small } from '../ui/text';
import {
  analyticsInput, byMonth, DRIVERS_EMPTY, DRIVERS_FOOTNOTE, drivers, monthSummary, NIGHT_LABEL, nightLine, nightTypes,
  seenText, weeklyShape, weeklySummary, yearOverYear, yearOverYearSummary,
} from './aggregates';
import { BarChart, EffectBar, HorizontalBars, LineChart } from './AnalyticsCharts';
import { calendarRange, fetchCalendar, fetchSalesHistory, type Calendar, type SalesHistory } from './api';
import { canFocus, focusBounds, heatmapMonths, heatmapSummary, MONTH_ROWS_LINE } from './cells';
import { DayPanel } from './DayPanel';
import { dayContext } from './days';
import { basisLine, defaultFilters, metricsWithData, toggleYear, yearsWithData, type Filters as FilterState } from './filters';
import { FilterPanel } from './FilterPanel';
import { Heatmap } from './Heatmap';
import { byDate, decodeHistory } from './history';
import { dayPanel } from './panel';
import { MONTH_NAMES, metricNumber, signedPercent, WEEKDAY_NAMES } from './words';
import { YourData } from './YourData';

// P24 Analytics (/locations/[id]/analytics, members; home.md 4, spec 16.3): the filters, every day as a heatmap
// with the Day panel, then the weekly shape, by month, year over year, by type of night, the biggest drivers, the
// model card ("How Townwise estimates", F9) and Your data. Every figure is an average or count of the location's own stored days that the filters keep, from
// the compute modules beside this file; a section with too few days says so instead of showing a number. Every
// section prints the same basis line. The page reads three routes (sales history, notes, the town calendar), and
// the model card reads its own (estimates/about); the page writes nothing and keeps its filters in component state only, so view-as shows it unchanged; only its upload
// links are disabled there.

const READ_ONLY_ID = 'analytics-ro';
const SHORT = (name: string | undefined): string => (name ?? '').slice(0, 3);

interface Data {
  history: SalesHistory;
  notes: Note[];
  calendar: Calendar;
}

/** A section whose content keeps to the reading column from 1024px (columns 1 to 7), as Sales data's chart does. */
function ChartSection(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return <Section title={props.title}><Columns main={<View style={styles.column}>{props.children}</View>} /></Section>;
}

function Basis(props: { line: string }): React.JSX.Element {
  return <Small>{props.line}</Small>;
}

/** The Every day section's row on desktop: heatmap in columns 1 to 8, the panel in 9 to 12, sticky. */
const sticky = (Platform.OS === 'web' ? { position: 'sticky', top: 16 } : {}) as unknown as ViewStyle;

function AnalyticsView(props: { data: Data; today: string; locationId: string; readOnlyId: string | null; readOnlyText: string }): React.JSX.Element {
  const { data, today, locationId, readOnlyId } = props;
  const { history, notes, calendar } = data;
  const { desktop } = useBreakpoint();
  const days = useMemo(() => decodeHistory(history), [history]);
  const index = useMemo(() => byDate(days), [days]);
  const context = useMemo(() => dayContext(notes, calendar.events), [notes, calendar.events]);
  const allYears = useMemo(() => yearsWithData(days), [days]);
  const metrics = useMemo(() => metricsWithData(days), [days]);
  const [filters, setFilters] = useState<FilterState>(() => defaultFilters(days));
  const [keepOne, setKeepOne] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const input = useMemo(() => analyticsInput(days, context, filters), [days, context, filters]);
  const { metric } = filters;
  const basis = useMemo(() => basisLine(days, filters, context), [days, filters, context]);
  const { coverage } = history;
  const native = Platform.OS !== 'web';
  // The aggregates, so a hover preview (which re-renders the page) recomputes none of them.
  const months = useMemo(() => heatmapMonths({ days, metric, years: filters.years }), [days, metric, filters.years]);
  const summary = useMemo(
    () => heatmapSummary({ days, metric, context, included: input.included, years: filters.years }, calendar) ?? '',
    [days, metric, context, input.included, filters.years, calendar],
  );
  const bounds = useMemo(() => focusBounds(days, filters.years, today), [days, filters.years, today]);
  const weekly = useMemo(() => weeklyShape(input), [input]);
  const monthly = useMemo(() => byMonth(input), [input]);
  const yoy = useMemo(() => yearOverYear(input), [input]);
  const nights = useMemo(() => nightTypes(input), [input]);
  const found = useMemo(() => drivers(input), [input]);

  /** Whether the heatmap still draws `date` under these filters: its year is checked, and on native its month has a row. */
  const shows = (date: string, next: FilterState): boolean => {
    if (!next.years.includes(Number(date.slice(0, 4)))) return false;
    return !native || heatmapMonths({ days, metric: next.metric, years: next.years }).some((row) => row.month === date.slice(0, 7));
  };
  const applyFilters = (next: FilterState): void => {
    setFilters(next);
    if (selected !== null && !shows(selected, next)) setSelected(null);
    if (preview !== null && !shows(preview, next)) setPreview(null);
  };
  const onFilters = (next: FilterState): void => { applyFilters(next); setKeepOne(false); };
  const onYear = (year: number, checked: boolean): void => {
    const result = toggleYear(filters, year, checked);
    setKeepOne(result.refused);
    applyFilters(result.filters);
  };

  const uploadLink = (label: string): React.JSX.Element | null => {
    if (Platform.OS !== 'web') return null;
    const href = `${locationHref(locationId, 'sales')}/upload`;
    return (
      <Actions>
        {readOnlyId === null
          ? <LinkButton href={href} label={label} />
          : <><Button variant="link" label={label} disabled describedBy={readOnlyId} /><ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} /></>}
      </Actions>
    );
  };

  if (days.length === 0 || coverage.firstDate === null || coverage.lastDate === null) {
    return (
      <View>
        <Stack gap={32}>
          <FilterPanel filters={filters} years={allYears} metrics={metrics} onChange={onFilters} onYear={onYear} keepOneYear={false} disabled />
          {history.uploadsOff === true ? (
            <EmptyState text={UPLOADS_OFF_LINE}>
              <Actions><LinkButton href={locationHref(locationId, 'data')} label="Open Your data" /></Actions>
            </EmptyState>
          ) : (
            <EmptyState text="No sales history yet.">
              <UploadAction locationId={locationId} variant="link" readOnlyId={readOnlyId} />
              {readOnlyId === null ? null : <ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} />}
            </EmptyState>
          )}
        </Stack>
      </View>
    );
  }

  const shown = preview ?? selected;
  const base = selected ?? shown;
  /**
   * The day before or after `from`. Web draws every day in the checked years; native draws only the months in its
   * list, so there a step into a month with no row jumps to the nearest listed month's edge (a seasonal closure),
   * and stops at the first and last listed months.
   */
  const neighbour = (from: string, by: -1 | 1): string | null => {
    const next = addDays(from, by);
    if (!native || months.some((row) => row.month === next.slice(0, 7))) return next;
    const month = next.slice(0, 7);
    const target = by < 0 ? months.find((row) => row.month < month) : months.findLast((row) => row.month > month);
    if (target === undefined) return null;
    const range = monthRange(target.month);
    return by < 0 ? range.to : range.from;
  };
  const step = (by: -1 | 1): (() => void) | null => {
    if (base === null || bounds === null) return null;
    const next = neighbour(base, by);
    if (next === null || !canFocus(next, bounds)) return null;
    return () => { setSelected(next); setPreview(null); setFocusKey((key) => key + 1); };
  };
  const panelData = shown === null ? null : dayPanel(shown, {
    byDate: index, context, uploads: history.uploads, metric, included: input.included, today, lastDate: coverage.lastDate, calendar,
  });
  const panel = <DayPanel data={panelData} locationId={locationId} onPrev={step(-1)} onNext={step(1)} />;
  const heatmap = (
    <Heatmap
      days={days}
      metric={metric}
      marks={filters.marks}
      context={context}
      included={input.included}
      years={filters.years}
      interactive
      selected={selected}
      onSelect={(date) => { setSelected(date); }}
      onPreview={setPreview}
      label={summary}
      today={today}
      focusKey={focusKey}
      panel={panel}
    />
  );
  const number = (value: number | null): string => (value === null ? 'No data' : metricNumber(value, metric));

  return (
    <View>
      <Lead>{`${plural(coverage.dayCount, 'day', 'days')}, ${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}.`}</Lead>
      <View style={styles.filters}>
        <FilterPanel filters={filters} years={allYears} metrics={metrics} onChange={onFilters} onYear={onYear} keepOneYear={keepOne} />
      </View>

      <Section title="Every day">
        {native ? (
          <Stack gap={12}>
            {heatmap}
            <Small>{MONTH_ROWS_LINE}</Small>
            <Small>{summary}</Small>
            <Basis line={basis} />
          </Stack>
        ) : (
          <View style={desktop ? styles.split : styles.stacked}>
            <View style={desktop ? styles.wide : null}>
              <Stack gap={12}>
                {heatmap}
                {desktop ? null : panel}
                <Basis line={basis} />
                <ShowNumbers>
                  <DataTable
                    label={`${metric === 'guests' ? 'Daily guests' : 'Daily net sales'} by month`}
                    columns={[
                      { key: 'month', label: 'Month' },
                      { key: 'days', label: 'Days with data', numeric: true },
                      { key: 'total', label: 'Total', numeric: true },
                      { key: 'mean', label: 'Average', numeric: true },
                    ]}
                    rows={months.map((row) => ({
                      key: row.month,
                      cells: { month: formatMonth(row.month), days: formatCount(row.days), total: number(row.total), mean: number(row.mean) },
                    }))}
                  />
                  <Small>Totals count every day with a value in the years you checked, including days your filters leave out.</Small>
                </ShowNumbers>
              </Stack>
            </View>
            {desktop ? <View style={[styles.narrow, sticky]}>{panel}</View> : null}
          </View>
        )}
      </Section>

      <ChartSection title="Weekly shape">
        <Small white>{weeklySummary(weekly, metric) ?? 'No days match your filters.'}</Small>
        <BarChart metric={metric} bars={weekly.map((stat) => ({ label: SHORT(WEEKDAY_NAMES[stat.weekday]), value: stat.mean }))} />
        <Basis line={basis} />
        <ShowNumbers>
          <DataTable
            label="Average per weekday"
            columns={[{ key: 'day', label: 'Weekday' }, { key: 'n', label: 'Days', numeric: true }, { key: 'mean', label: 'Average', numeric: true }]}
            rows={weekly.map((stat) => ({
              key: String(stat.weekday),
              cells: { day: WEEKDAY_NAMES[stat.weekday] ?? '', n: formatCount(stat.n), mean: number(stat.mean) },
            }))}
          />
        </ShowNumbers>
      </ChartSection>

      <ChartSection title="By month">
        <Small white>{monthSummary(monthly, metric) ?? 'No days match your filters.'}</Small>
        <BarChart metric={metric} bars={monthly.map((stat) => ({ label: SHORT(MONTH_NAMES[stat.month - 1]), value: stat.meanPerDay }))} />
        <Basis line={basis} />
        <ShowNumbers>
          <DataTable
            label="Average per day in each month"
            columns={[{ key: 'month', label: 'Month' }, { key: 'n', label: 'Days', numeric: true }, { key: 'mean', label: 'Average', numeric: true }]}
            rows={monthly.map((stat) => ({
              key: String(stat.month),
              cells: { month: MONTH_NAMES[stat.month - 1] ?? '', n: formatCount(stat.n), mean: number(stat.meanPerDay) },
            }))}
          />
        </ShowNumbers>
      </ChartSection>

      <ChartSection title="Year over year">
        <Small white>{yearOverYearSummary(yoy)}</Small>
        {yoy.gap === 'history' ? uploadLink('Upload older history') : null}
        <LineChart
          metric={metric}
          lines={yoy.years.map((year) => ({
            year,
            points: yoy.cells.filter((cell) => cell.year === year).map((cell) => (cell.meanPerDay === null ? null : { value: cell.meanPerDay, complete: cell.complete })),
          }))}
        />
        <Basis line={basis} />
        <ShowNumbers>
          <DataTable
            label="Average per day by year and month"
            columns={[
              { key: 'month', label: 'Month' }, { key: 'n', label: 'Days', numeric: true }, { key: 'of', label: 'Of', numeric: true },
              { key: 'mean', label: 'Average', numeric: true },
            ]}
            rows={yoy.cells.filter((cell) => cell.n > 0).map((cell) => ({
              key: `${String(cell.year)}-${String(cell.month)}`,
              cells: {
                month: `${MONTH_NAMES[cell.month - 1] ?? ''} ${String(cell.year)}`, n: formatCount(cell.n), of: formatCount(cell.daysInMonth),
                mean: number(cell.meanPerDay),
              },
            }))}
          />
        </ShowNumbers>
      </ChartSection>

      <ChartSection title="By type of night">
        <Stack gap={4}>
          {nights.map((night) => <Small key={night.type} white>{nightLine(night, metric)}</Small>)}
        </Stack>
        <HorizontalBars metric={metric} bars={nights.map((night) => ({ label: NIGHT_LABEL[night.type], value: night.mean }))} />
        <Basis line={basis} />
        <ShowNumbers>
          <DataTable
            label="Nights by type"
            columns={[
              { key: 'type', label: 'Type', flex: 1.6 }, { key: 'n', label: 'Nights', numeric: true }, { key: 'mean', label: 'Average', numeric: true },
              { key: 'change', label: 'Against regular', numeric: true, flex: 1.2 },
            ]}
            rows={nights.map((night) => ({
              key: night.type,
              cells: {
                type: NIGHT_LABEL[night.type], n: formatCount(night.n), mean: night.mean === null ? 'None' : metricNumber(night.mean, metric),
                change: night.change === null ? 'None' : signedPercent(night.change),
              },
            }))}
          />
        </ShowNumbers>
      </ChartSection>

      <ChartSection title="Biggest drivers">
        {found.length === 0 ? <Small white>{DRIVERS_EMPTY}</Small> : (
          <DataTable
            label="Biggest drivers"
            columns={[
              { key: 'rank', label: '#', flex: 0.4 }, { key: 'driver', label: 'Driver', flex: 1.6 },
              ...(native ? [] : [{ key: 'bar', label: 'Effect, 50% fewer to 50% more', hiddenLabel: true, flex: 1.4 }]),
              { key: 'effect', label: 'Effect', numeric: true }, { key: 'seen', label: 'Seen', flex: 1.4 },
            ]}
            rows={found.map((driver, at) => ({
              key: driver.key,
              cells: {
                rank: String(at + 1), driver: driver.rough ? `${driver.label} (rough)` : driver.label,
                bar: <EffectBar effect={driver.effect} />, effect: signedPercent(driver.effect), seen: seenText(driver),
              },
            }))}
          />
        )}
        <Small>{DRIVERS_FOOTNOTE}</Small>
        <Basis line={basis} />
        <View style={styles.planned}>
          <StatusTag kind="planned" label="Planned" />
          <Small>Weather as a driver.</Small>
        </View>
      </ChartSection>

      <Section><Columns main={<ModelCard locationId={locationId} />} /></Section>

      <ChartSection title="Your data">
        <YourData coverage={coverage} uploads={history.uploads} locationId={locationId} />
      </ChartSection>
    </View>
  );
}

export function Analytics(): React.JSX.Element {
  const { location } = useLocation();
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [today] = useState(localToday);
  const { state, reload } = useLoad(useCallback(async () => {
    const [history, notes] = await Promise.all([fetchSalesHistory(api, location.id), fetchNotes(api, location.id)]);
    const calendar = await fetchCalendar(api, location.id, calendarRange(history.coverage.firstDate, today));
    return { history, notes, calendar };
  }, [api, location.id, today]));
  if (state.status === 'loading') return <Loading text="Loading analytics" />;
  if (state.status === 'failed') return <LoadFailure error={state.error} onRetry={reload} />;
  return (
    <AnalyticsView
      key={location.id}
      data={state.data}
      today={today}
      locationId={location.id}
      readOnlyId={readOnly ? READ_ONLY_ID : null}
      readOnlyText={line}
    />
  );
}

const styles = StyleSheet.create({
  filters: { marginTop: theme.space[6] },
  split: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  stacked: { gap: theme.space[6] },
  wide: { flex: 8, minWidth: 0 },
  narrow: { flex: 4, minWidth: 0 },
  column: { gap: theme.space[5] },
  planned: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
});
