import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { ResearchedEvent } from '../analytics/api';
import { addDays, localToday } from '../locations/dates';
import { shownLocationName } from '../locations/naming';
import { useMapTheme } from '../places/map';
import { PlaceMap } from '../places/PlaceMap';
import { usePortal } from '../PortalProvider';
import { fetchCompetition, type Competition } from '../research/api';
import type { LocationSummary, OrgResponse } from '../schemas';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { Section } from '../ui/layout';
import {
  COMPETITION_DAYS, COMPETITION_FAILED, COMPETITION_HEADING, COMPETITION_LEAD, COMPETITION_NO_EVENTS, COMPETITION_NO_PLACE, COMPETITION_NONE,
  COMPETITION_PLACES_OFF, COMPETITION_SOURCE, COMPETITION_WEB_HEADING, competitionMapLabel, competitorLine,
} from './research-copy';
import { EventItem, firstDay } from './EventItem';

// P15's Competition card (D66, OpenSpec change town-research-agent, design decisions 10 and 15): GET .../competition
// in the portal's mode, Google's nearby restaurants, bars and cafes (read live for this view; Townwise keeps none of
// their names) lettered A to H on a map fitted around the location, each competitor with its upcoming public events
// research found (60 days, after this location's edits), and the competitor events no live competitor matched under
// "Competing events found on the web", by the business's name. The letters show only beside a map that loaded: with
// no map, or when it fails to load, the list is plain. No place, or Google off: the gap's line, and the web list still
// shows. A read only; it re-reads when the page's research run ends (`tick`).

type Load = { status: 'loading' } | { status: 'failed'; error: unknown } | { status: 'ready'; data: Competition };

export function CompetitionCard(props: { location: LocationSummary; org: OrgResponse; tick: number }): React.JSX.Element {
  const { location, org, tick } = props;
  const { api } = usePortal();
  const mode = useMapTheme();
  const [state, setState] = useState<{ key: string; load: Load } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const key = `${location.id}:${mode}:${String(tick)}`;
  useEffect(() => {
    let live = true;
    fetchCompetition(api, location.id, mode).then(
      (data) => { if (live) setState({ key, load: { status: 'ready', data } }); },
      (error: unknown) => { if (live) setState({ key, load: { status: 'failed', error } }); },
    );
    return () => { live = false; };
  }, [api, location.id, mode, key]);
  const load = state?.load ?? { status: 'loading' };

  return (
    <Section title={COMPETITION_HEADING}>
      <View style={styles.block}>
        <Text style={styles.body}>{COMPETITION_LEAD}</Text>
        {load.status === 'loading' ? <LoadingLine text="Loading the competition" minHeight={48} /> : null}
        {load.status === 'failed' ? <ErrorNotice message={COMPETITION_FAILED} /> : null}
        {load.status === 'ready' ? (
          <Competitors
            data={load.data}
            locationId={location.id}
            name={shownLocationName(location, org)}
            failedUrl={failedUrl}
            onFailed={setFailedUrl}
          />
        ) : null}
      </View>
    </Section>
  );
}

function Competitors(props: {
  data: Competition; locationId: string; name: string; failedUrl: string | null; onFailed: (url: string) => void;
}): React.JSX.Element {
  const { data } = props;
  const map = data.competitors.length === 0 ? null : data.map;
  const letters = map !== null && map.url !== props.failedUrl;
  return (
    <View style={styles.block}>
      {data.gap === 'no_place' ? <Text style={styles.body}>{COMPETITION_NO_PLACE}</Text> : null}
      {data.gap === 'places_off' ? <Text style={styles.body}>{COMPETITION_PLACES_OFF}</Text> : null}
      {data.gap === null && data.competitors.length === 0 ? <Text style={styles.body}>{COMPETITION_NONE}</Text> : null}
      {map === null ? null : (
        <View style={styles.frame}>
          <PlaceMap map={map} label={competitionMapLabel(props.name)} onFailed={props.onFailed} />
        </View>
      )}
      {data.competitors.length === 0 ? null : (
        <View role="list" style={styles.list}>
          {data.competitors.map((competitor) => (
            <View key={competitor.placeId} role="listitem" style={styles.competitor}>
              <View style={styles.head}>
                {letters ? <Text style={styles.letter} aria-hidden>{competitor.letter}</Text> : null}
                <View style={styles.headText}>
                  <Text style={styles.name}>{letters ? `${competitor.letter}. ${competitor.name}` : competitor.name}</Text>
                  <Text style={styles.help}>{competitorLine(competitor)}</Text>
                </View>
              </View>
              <Events locationId={props.locationId} events={competitor.events} />
            </View>
          ))}
        </View>
      )}
      {data.competitors.length === 0 ? null : <Text style={styles.help}>{COMPETITION_SOURCE}</Text>}
      {data.web.length === 0 ? null : (
        <View style={styles.block}>
          <Text style={styles.subhead} role="heading" aria-level={3}>{COMPETITION_WEB_HEADING}</Text>
          <View role="list" style={styles.list}>
            {data.web.map((business) => (
              <View key={business.name} role="listitem" style={styles.competitor}>
                <Text style={styles.name}>{business.name}</Text>
                <Events locationId={props.locationId} events={business.events} />
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function Events(props: { locationId: string; events: readonly ResearchedEvent[] }): React.JSX.Element {
  if (props.events.length === 0) return <Text style={styles.help}>{COMPETITION_NO_EVENTS}</Text>;
  const today = localToday();
  const last = addDays(today, COMPETITION_DAYS);
  return (
    <View role="list" style={styles.events}>
      {props.events.map((event) => (
        <EventItem key={event.id} locationId={props.locationId} event={event} day={firstDay(event, today, last)} />
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  block: { gap: theme.space[3] },
  frame: { width: '100%', maxWidth: 640 },
  list: { gap: theme.space[4] },
  competitor: { gap: theme.space[2] },
  head: { flexDirection: 'row', gap: theme.space[2], alignItems: 'flex-start' },
  headText: { flexShrink: 1, gap: 2 },
  letter: {
    ...theme.type.label, color: c.white, minWidth: 22, textAlign: 'center', paddingVertical: 2,
    borderWidth: theme.stroke.hairline, borderColor: c.border,
  },
  events: { gap: theme.space[2], paddingLeft: theme.space[3] },
  name: { ...theme.type.small, color: c.white },
  subhead: { ...theme.type.small, color: c.white, fontWeight: 600 },
  body: { ...theme.type.small, color: c.text2 },
  help: { ...theme.type.small, color: c.text3 },
});
