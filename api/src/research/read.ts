// What research found, as one location sees it (D66, design decisions 9 and 11): the town's rows (when the location's
// town is one of the twelve; a row staff suppressed left out), the location's own rows stamped with its current place
// and town (a row of an earlier place or town is stale and left out), each folded with this location's revisions
// (research/revisions.ts). Ids are `t-<hex>` for a town row and `l-<hex>` for a location row; each view carries its
// `head`, the `basedOn` an edit of it sends.
//
// A location row that is the same happening as one of its town's rows (dedupe.ts sameEvent, on what research found) is
// left out, its sources (and its competitor) folded into the town's view: a town run and a location run that merge in
// either order show it once. The location run's merge drops such a finding when the town's row is already stored
// (merge.ts `town_dupe`); this read covers a town run that merged after it.
//
// The one reader of researched events for the calendar route, TownwiseAI's tools, weekly suggestions and the research
// routes. It answers `[]` while the organization's research switch or TOWNWISE_RESEARCH is off, so nothing researched
// is read for an organization that turned it off, and `null` when a read fails, so a caller shows everything else
// (the calendar answers `found: null`). Revisions are read only under the caller's own scope and location: another
// organization's, or another location's, never reach a view. The forecast's town calendar (town-calendar.ts) never
// reads these rows (spec 13.1).
//
// A read logs nothing; a failed read logs one warning with the location's id and the error's name.
import type { Logger } from '@ckeith26/server-core';

import type { OrgScope } from '../access/policy.ts';
import type { ResolvedTownwiseConfig } from '../config.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { EntityRecordBase, EventRecordBase } from '../stores/research-shared.ts';
import { sameEvent, type Comparable } from './dedupe.ts';
import { isTownId, townStamp } from './plan.ts';
import { foldRevisions } from './revisions.ts';
import type { LocationOrigin } from './threads.ts';
import { MAX_EVENT_SOURCES, type Confidence, type EventCategory, type EventKind, type EventStatus, type SourceRef } from './verify.ts';

export interface ResearchReadContext {
  readonly stores: TownwiseStores;
  readonly config: Pick<ResolvedTownwiseConfig, 'research'>;
  readonly logger: Logger;
}

export type ResearchedOrigin = 'town' | LocationOrigin;

/** A researched event as one location sees it (spec 10.10's `found` item). */
export interface ResearchedEventView {
  /** `t-<hex>` (a town row) or `l-<hex>` (a location row). */
  readonly id: string;
  /** `'base'`, or the id of the head revision: what an edit sends as `basedOn`. */
  readonly head: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly weekdays: readonly number[] | null;
  readonly startTime: string | null;
  readonly kind: EventKind;
  readonly category: EventCategory;
  readonly status: EventStatus;
  readonly origin: ResearchedOrigin;
  readonly confidence: Confidence;
  /** The venue's name as research found it, or as a member edited it. */
  readonly where: string | null;
  /** The host's name as research found it. */
  readonly who: string | null;
  /** A competitor's event: its business entity, and its Google place id when the run had one. */
  readonly competitor: { readonly entityId: string | null; readonly placeId: string | null } | null;
  readonly sources: readonly SourceRef[];
  /** When research last found it (ISO); "Last confirmed {date}" for a row not found again. */
  readonly lastSeenAt: string;
  readonly edited: boolean;
  readonly hidden: boolean;
}

export interface DayRange { readonly from: string; readonly to: string }

const TOWN_PREFIX = 't-';
const LOCATION_PREFIX = 'l-';

/** A view id's kind and hex id, or null for anything else (a curated row's or holiday's id included). */
export function parseResearchedId(id: string): { readonly kind: 'town' | 'location'; readonly hex: string } | null {
  const match = /^([tl])-([0-9a-f]{24})$/.exec(id);
  if (match === null) return null;
  return { kind: match[1] === 't' ? 'town' : 'location', hex: match[2] ?? '' };
}

/** Whether `id` is a researched event's view id. */
export const isResearchedId = (id: string): boolean => parseResearchedId(id) !== null;

function viewOf(
  id: string, row: EventRecordBase, origin: ResearchedOrigin, entities: ReadonlyMap<string, EntityRecordBase>,
  revisions: Parameters<typeof foldRevisions>[2], competitor: ResearchedEventView['competitor'],
): ResearchedEventView {
  const nameOf = (entityId: string | null) => (entityId === null ? null : entities.get(entityId)?.name ?? null);
  const folded = foldRevisions(id, {
    title: row.title, start: row.start, end: row.end, weekdays: row.weekdays, startTime: row.startTime, where: nameOf(row.venueId),
  }, revisions);
  return {
    id, head: folded.head, ...folded.values, kind: row.kind, category: row.category, status: row.status, origin,
    confidence: row.confidence, who: nameOf(row.hostId), competitor, sources: row.sources.map((s) => ({ label: s.label, url: s.url })),
    lastSeenAt: row.lastSeenAt.toISOString(), edited: folded.edited, hidden: folded.hidden,
  };
}

/** Whether research is read for this organization: TOWNWISE_RESEARCH and the organization's own switch. */
export async function researchReadable(ctx: ResearchReadContext, scope: OrgScope): Promise<boolean> {
  if (!ctx.config.research) return false;
  const org = await ctx.stores.orgs.findById(scope.orgId);
  return org?.research.on === true;
}

/**
 * Every researched view of the location, hidden ones included (`hidden: true`), overlapping `range` (by the shown
 * dates) when one is given, ordered by start. `[]` while research is off for the organization; throws on a failed read.
 */
export async function readResearchedViews(
  ctx: ResearchReadContext, scope: OrgScope, location: LocationRecord, range: DayRange | null,
): Promise<ResearchedEventView[]> {
  if (!await researchReadable(ctx, scope)) return [];
  const townId = location.town.townId !== null && isTownId(location.town.townId) ? location.town.townId : null;
  const stamp = { placeId: location.placeId, town: townStamp(location.town) };
  const [townRows, townEntities, ownRows, ownEntities, revisions] = await Promise.all([
    townId === null ? Promise.resolve([]) : ctx.stores.researchTowns.events(townId),
    townId === null ? Promise.resolve([]) : ctx.stores.researchTowns.entities(townId),
    ctx.stores.researchLocations.events(scope, location.id),
    ctx.stores.researchLocations.entities(scope, location.id),
    ctx.stores.researchRevisions.list(scope, location.id),
  ]);
  const byId = (list: readonly EntityRecordBase[]) => new Map(list.map((entity) => [entity.id, entity]));
  const townNames = byId(townEntities);
  const ownNames = byId(ownEntities);
  const comparable = (row: EventRecordBase, names: ReadonlyMap<string, EntityRecordBase>): Comparable => ({
    title: row.title, start: row.start, end: row.end, category: row.category,
    venueKey: row.venueId === null ? null : names.get(row.venueId)?.nameKey ?? null,
  });
  const town = townRows.filter((row) => row.suppressed === null).map((row) => ({
    match: comparable(row, townNames), view: viewOf(`${TOWN_PREFIX}${row.id}`, row, 'town', townNames, revisions, null),
  }));
  const own: ResearchedEventView[] = [];
  for (const row of ownRows.filter((each) => each.placeId === stamp.placeId && each.town === stamp.town)) {
    const competitor = row.competitorEntityId === null && row.competitorPlaceId === null ? null
      : { entityId: row.competitorEntityId, placeId: row.competitorPlaceId };
    const same = town.find((each) => sameEvent(comparable(row, ownNames), each.match));
    if (same === undefined) {
      own.push(viewOf(`${LOCATION_PREFIX}${row.id}`, row, row.origin, ownNames, revisions, competitor));
      continue;
    }
    const sources = [...same.view.sources];
    for (const source of row.sources) {
      if (sources.length < MAX_EVENT_SOURCES && !sources.some((kept) => kept.url === source.url)) sources.push({ label: source.label, url: source.url });
    }
    same.view = { ...same.view, sources, competitor: same.view.competitor ?? competitor };
  }
  const views = [...town.map((each) => each.view), ...own];
  return views
    .filter((view) => range === null || (view.start <= range.to && view.end >= range.from))
    .sort((a, b) => (a.start === b.start ? (a.id < b.id ? -1 : 1) : a.start < b.start ? -1 : 1));
}

/**
 * The location's researched events in `range` after its revisions, hidden ones left out: the calendar's `found` and
 * TownwiseAI's. `[]` while research is off for the organization; null when the read fails.
 */
export async function researchedEventsFor(
  ctx: ResearchReadContext, scope: OrgScope, location: LocationRecord, range: DayRange,
): Promise<ResearchedEventView[] | null> {
  try {
    return (await readResearchedViews(ctx, scope, location, range)).filter((view) => !view.hidden);
  } catch (err) {
    ctx.logger.warn({ locationId: location.id, errName: err instanceof Error ? err.name : 'unknown' }, 'townwise.research_read_failed');
    return null;
  }
}
