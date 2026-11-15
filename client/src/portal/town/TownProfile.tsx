import { useState } from 'react';
import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fmt1, fmtSigned } from '../../marketing/format';
import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import type { Town } from '../schemas';
import {
  CAVEATS, DATA_YEAR, INDEX_DEFINITION, KIND_LABEL, MONTHS, PATTERN_LABEL, SOURCES, dateRange, northeastSeries,
  notResearchedLine, patternGap, sourceLinks, townProfile, townSentences, type MeasuredProfile, type TownProfileData,
} from '../towns';
import { DataTable } from '../ui/DataTable';
import { StatusTag } from '../ui/feedback';
import { Columns, Stack } from '../ui/layout';
import { Eyebrow, Heading, Mono, Small } from '../ui/text';
import { TownChart } from './TownChart';

// A town's public profile (spec Section 13), for Waiting (P4) and the Town tab (P15), from the bundled data:
// the kind tag, the anchor note, the county it is measured across, its 2025 food-service employment pattern
// against the Northeast (the chart on web; its text summary and “Show the numbers” everywhere), the drivers and
// key dates with their sources, the caveats, the index definition and the source. County, not town; employment,
// not sales. A town outside the twelve gets the honest gap line and no chart; one whose county BLS did not publish
// for the whole year says why in place of its pattern, with no chart, numbers or sentences.

const BLS_SOURCES = SOURCES.filter((source) => source.url.startsWith('https://www.bls.gov/'));

function Sources(props: { urls: readonly string[] }): React.JSX.Element {
  return (
    <View style={styles.sourceRow}>
      {sourceLinks(props.urls).map((link) => (
        <Link key={link.url} href={link.url as Href} style={styles.sourceLink}>{link.text}</Link>
      ))}
    </View>
  );
}

function Numbers(props: { profile: MeasuredProfile }): React.JSX.Element {
  const { series, county } = props.profile;
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.numbers}>
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={() => { setOpen((value) => !value); }}
        style={styles.toggle}
      >
        <View style={styles.toggleBox}><Text style={styles.toggleGlyph}>{open ? '−' : '+'}</Text></View>
        <Text style={styles.toggleText}>Show the numbers</Text>
      </Pressable>
      {open ? (
        <DataTable
          label={`Numbers: ${county} and the Northeast, ${String(DATA_YEAR)}`}
          columns={[
            { key: 'month', label: 'Month' },
            { key: 'county', label: county, numeric: true },
            { key: 'northeast', label: 'Northeast', numeric: true },
            { key: 'gap', label: 'Gap', numeric: true },
          ]}
          rows={MONTHS.map((month, index) => ({
            key: month,
            cells: {
              month,
              county: fmt1(series.index[index] ?? 0),
              northeast: fmt1(northeastSeries.index[index] ?? 0),
              gap: fmtSigned(series.gap[index] ?? 0),
            },
          }))}
        />
      ) : null}
    </View>
  );
}

function Notes(props: { profile: TownProfileData }): React.JSX.Element {
  const { profile } = props;
  const { drivers, dates, name } = profile;
  return (
    <View style={styles.notes}>
      {drivers.length === 0 ? null : (
        <Stack gap={6}>
          <Eyebrow>Drivers</Eyebrow>
          {drivers.map((driver) => (
            <View key={driver.text}>
              <Small>{driver.text}</Small>
              <Sources urls={driver.sourceUrls} />
            </View>
          ))}
        </Stack>
      )}
      {dates.length === 0 ? null : (
        <Stack gap={6}>
          <Eyebrow>Dates</Eyebrow>
          {dates.map((date) => (
            <View key={date.text + date.start}>
              <Small>{`${date.text}, ${dateRange(date.start, date.end)}`}</Small>
              <Sources urls={date.sourceUrls} />
            </View>
          ))}
        </Stack>
      )}
      {drivers.length === 0 ? <Small>{`No drivers or key dates are researched for ${name} yet.`}</Small> : null}
      {drivers.length > 0 && dates.length === 0 ? <Small>{`No key dates are researched for ${name} yet.`}</Small> : null}
      <Stack gap={12}>
        {CAVEATS.map((caveat) => <Text key={caveat} style={styles.fine}>{caveat}</Text>)}
        {profile.series === null ? null : <Text style={styles.fine}>{`Curve: ${String(DATA_YEAR)} employment.`}</Text>}
        <Text style={styles.fine}>
          {`Source: U.S. Bureau of Labor Statistics, QCEW, private food services and drinking places (NAICS 722), ${profile.county}, ${String(DATA_YEAR)}.`}
        </Text>
        <Text style={styles.fine}>{INDEX_DEFINITION}</Text>
        {BLS_SOURCES.map((source) => (
          <Link key={source.url} href={source.url as Href} style={[styles.fine, styles.sourceList]}>{source.label}</Link>
        ))}
      </Stack>
    </View>
  );
}

/** The swatch, the pattern's name and its biggest gap with the region, the signed delta in mono (spec 15.7). */
export function PatternLine(props: { profile: MeasuredProfile }): React.JSX.Element {
  const { profile } = props;
  const { phone } = useBreakpoint();
  const gap = patternGap(profile);
  const delta = fmtSigned(profile.series.largestGap.signedGap);
  const at = gap.indexOf(delta);
  return (
    <View style={styles.pattern}>
      <View aria-hidden style={[styles.swatch, profile.pattern === 'moves' ? styles.swatchMoves : null]} />
      <Text style={[phone ? theme.type.sub : theme.type.small, styles.patternText]}>
        <Text style={styles.patternLabel}>{PATTERN_LABEL[profile.pattern]}</Text>
        {at < 0 ? gap : (
          <>
            {gap.slice(0, at)}
            <Mono>{delta}</Mono>
            {gap.slice(at + delta.length)}
          </>
        )}
      </Text>
    </View>
  );
}

export function TownProfile(props: { town: Town; heading: string }): React.JSX.Element {
  const profile = townProfile(props.town.townId);
  if (profile === null) {
    return (
      <Stack>
        <Heading>{props.heading}</Heading>
        <Small>{notResearchedLine(props.town)}</Small>
      </Stack>
    );
  }
  return (
    <View style={styles.profile}>
      <View style={styles.head}>
        <Eyebrow>{`Historical public data, ${String(DATA_YEAR)}`}</Eyebrow>
        <View style={styles.titleRow}>
          <Heading>{props.heading}</Heading>
          <StatusTag label={KIND_LABEL[profile.kind]} />
        </View>
      </View>
      <View style={styles.intro}>
        <Small>{profile.note}</Small>
        {profile.series === null ? <Small>{profile.seriesUnavailable}</Small> : (
          <>
            <Small>{`Measured across ${profile.county}, ${String(DATA_YEAR)}.`}</Small>
            <PatternLine profile={profile} />
          </>
        )}
      </View>
      {profile.series === null ? null : (
        <Columns
          main={(
            <Stack gap={8}>
              <TownChart profile={profile} />
              <Text style={styles.fine}>County level. Jobs stand in for demand; they are not sales.</Text>
              <Numbers profile={profile} />
            </Stack>
          )}
          side={<Stack gap={8}>{townSentences(profile).map((line) => <Small key={line}>{line}</Small>)}</Stack>}
        />
      )}
      <Notes profile={profile} />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  profile: { gap: theme.space[6] },
  head: { gap: theme.space[2] },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  intro: { gap: theme.space[2], maxWidth: 640 },
  pattern: { flexDirection: 'row', alignItems: 'flex-start', columnGap: 10 },
  swatch: { width: 12, height: 12, marginTop: 4, borderRadius: 6, backgroundColor: c.mint },
  swatchMoves: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: c.mint },
  patternText: { color: c.text2, flex: 1 },
  patternLabel: { fontWeight: 500, color: c.white },
  fine: { ...theme.type.mono, color: c.text3 },
  numbers: { gap: theme.space[2] },
  toggle: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, alignSelf: 'flex-start' },
  toggleBox: { width: 16, height: 16, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  toggleGlyph: { ...theme.type.mono, lineHeight: 14, color: c.text2 },
  toggleText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  notes: { gap: theme.space[6], paddingTop: theme.space[6], borderTopWidth: 1, borderTopColor: c.border },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 },
  sourceLink: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
  sourceList: { minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
});
