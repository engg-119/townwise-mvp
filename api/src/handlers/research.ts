// D66's research routes (openspec change town-research-agent, design decisions 13 and 15; spec 10.19).
//
// GET /api/org/locations/:locationId/research (`org.research.get`, member, open as admin too): what the Town tab shows.
// The organization's switch, whether research runs in this deploy, the town's last run (status, finish time, its
// threads' states and the counts, never what started it or when: a town run is shared, and nothing another
// organization did may show), the location's own last run with its trigger and start, the day of its next weekly run,
// the gaps the tab explains, who and where (the entities the upcoming events name), and the events hidden at this
// location with their heads (for Restore). A read: it logs nothing.
//
// GET /api/org/locations/:locationId/competition?theme= (`org.competition.get`, member, the `places` limiter, open as
// admin too): the Competition card. Google's Nearby Search around the location's place, live for this view (names,
// types and points are answered and stored nowhere), the competitors lettered on a map Townwise fits around the
// location and them, and each competitor's upcoming researched events (60 days, after this location's edits) put under
// its letter when the event stored the competitor's place id or its business entity's name key equals the live display
// name's (research/competitors.ts matchCompetitor; the match is computed here and stored and sent nowhere). Competitor
// events matching no live competitor are listed under "Competing events found on the web", by the business's name, so
// the card works with Google's names kept from Anthropic (the shipped config) and with Places off. It logs counts only.
//
// PATCH /api/org/locations/:locationId/research/events/:eventId (`org.research.event_update`, member, open as admin too,
// never under view-as): a person's edit, hide or restore of a researched event at this location only (design decision
// 11). It appends a revision based on the head the person saw (`basedOn`); a lost race, or a head that moved since, answers
// 409 `changed_since` with the event's current view. `title` and `where` pass `safeText`, the dates verify's date rules.
// Curated rows and holidays are not researched events, so their ids answer 404, as another town's or organization's. It
// writes an audit event with the location's and the event's ids only, and logs nothing.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { recordAfter } from '../audit.ts';
import { isoDate } from '../dates.ts';
import { PlacesUnavailableError } from '../places/google.ts';
import { mapThemeSchema, pinLabel, STATIC_MAP_HEIGHT, STATIC_MAP_WIDTH, type PlaceMap } from '../places/static-map.ts';
import { fitView, type LatLng } from '../places/view.ts';
import { COMPETITOR_RADIUS_M, matchCompetitor, pickCompetitors, type Competitor } from '../research/competitors.ts';
import { isTownId, nextWeeklyRunDay, researchRuns } from '../research/plan.ts';
import { parseResearchedId, readResearchedViews, researchedEventsFor, type ResearchedEventView } from '../research/read.ts';
import { MAX_LOCATION_REVISIONS } from '../research/revisions.ts';
import { researchWindow } from '../research/threads.ts';
import { datesRefused, MAX_TITLE_CHARS, safeText, TIME } from '../research/verify.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { LocationRunRecord, RunTrigger } from '../stores/research-locations.ts';
import type { EntityRecordBase, RunCounts, RunRecordBase, RunStatus, ThreadRecordBase } from '../stores/research-shared.ts';
import type { RevisionFields, RevisionOp } from '../stores/research-revisions.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { pointOf } from './locations-map.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** A run's thread as the Town tab shows it: a queued thread with a code is waiting to try again. */
export interface ThreadView { readonly thread: string; readonly status: string; readonly code: string | null }

/** A town run: no trigger and no start, so nothing another organization did shows. */
export interface TownRunView {
  readonly status: RunStatus;
  readonly finishedAt: string | null;
  readonly threads: readonly ThreadView[];
  readonly counts: RunCounts;
}

export interface RunView extends TownRunView { readonly trigger: RunTrigger; readonly startedAt: string | null }

export const RESEARCH_GAPS = ['no_place', 'not_researched_town', 'off', 'budget', 'places_off'] as const;
export type ResearchGap = typeof RESEARCH_GAPS[number];

/** How many entities "Who and where" lists. */
export const WHO_AND_WHERE_MAX = 8;

function threadViews(run: RunRecordBase, threads: readonly ThreadRecordBase[]): ThreadView[] {
  const byId = new Map(threads.map((thread) => [thread.thread, thread]));
  // Every planned thread, a row not yet inserted shown as queued.
  return run.threads.map((id) => {
    const row = byId.get(id);
    return { thread: id, status: row?.status ?? 'queued', code: row?.code ?? null };
  });
}

function townRunView(run: RunRecordBase, threads: readonly ThreadRecordBase[]): TownRunView {
  return { status: run.status, finishedAt: run.finishedAt?.toISOString() ?? null, threads: threadViews(run, threads), counts: run.counts };
}

function runView(run: LocationRunRecord, threads: readonly ThreadRecordBase[]): RunView {
  return { ...townRunView(run, threads), trigger: run.trigger, startedAt: run.startedAt?.toISOString() ?? null };
}

/** The entities the upcoming shown events name, most events first, at most WHO_AND_WHERE_MAX. */
function whoAndWhere(views: readonly ResearchedEventView[], entities: readonly EntityRecordBase[]) {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  const counts = new Map<string, number>();
  for (const view of views) {
    for (const name of new Set([view.where, view.who])) {
      if (name !== null && byName.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, WHO_AND_WHERE_MAX)
    .flatMap(([name, events]) => {
      const entity = byName.get(name);
      return entity === undefined ? [] : [{ id: entity.id, type: entity.type, name: entity.name, events }];
    });
}

export async function getResearch(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const location: LocationRecord = await loadLocation(ctx, scope, req.params.locationId);
  const now = ctx.now();
  const { timeZone } = timeZoneOf(location.town);
  const townId = location.town.townId !== null && isTownId(location.town.townId) ? location.town.townId : null;
  const available = researchRuns({ research: ctx.config.research, chatWebSearch: ctx.config.chatWebSearch, anthropicKey: ctx.chat !== null });
  // The organization's own switch (the tab's toggle shows it whatever the deploy does); research is read only while it
  // and TOWNWISE_RESEARCH are both on.
  const on = (await ctx.stores.orgs.findById(scope.orgId))?.research.on ?? false;
  const readable = on && ctx.config.research;
  const [townRun, locationRun, liveRun] = await Promise.all([
    townId === null ? Promise.resolve(null) : ctx.stores.researchTowns.lastRun(townId),
    ctx.stores.researchLocations.lastRun(scope, location.id),
    ctx.stores.researchLocations.liveRun(scope, location.id),
  ]);
  const [townThreads, locationThreads] = await Promise.all([
    townRun === null ? Promise.resolve([]) : ctx.stores.researchTowns.threadsOf(townRun.id),
    locationRun === null ? Promise.resolve([]) : ctx.stores.researchLocations.threadsOf(scope, locationRun.id),
  ]);
  const window = researchWindow(now, timeZone);
  const views = readable ? await readResearchedViews(ctx, scope, location, null) : [];
  const upcoming = views.filter((view) => !view.hidden && view.end >= window.from && view.start <= window.to);
  const [townEntities, ownEntities] = readable
    ? await Promise.all([
      townId === null ? Promise.resolve([]) : ctx.stores.researchTowns.entities(townId),
      ctx.stores.researchLocations.entities(scope, location.id),
    ])
    : [[], []];

  const gaps = new Set<ResearchGap>();
  if (!readable || !available) gaps.add('off');
  if (location.placeId === null) gaps.add('no_place');
  if (townId === null) gaps.add('not_researched_town');
  if (locationRun !== null && (locationRun.status === 'budget' || locationThreads.some((thread) => thread.status === 'budget'))) gaps.add('budget');
  if (locationThreads.some((thread) => thread.code === 'places_off')
    || (ctx.config.researchPlacesToAi && ctx.places === null && location.placeId !== null)) gaps.add('places_off');

  const automatic = readable && available && ctx.config.researchOrgMonthlyUsd > 0;
  res.status(200).json({
    on,
    available,
    town: townRun === null ? null : townRunView(townRun, townThreads),
    location: locationRun === null ? null : runView(locationRun, locationThreads),
    next: automatic && liveRun === null ? nextWeeklyRunDay(locationRun, now, timeZone, location.id) : null,
    gaps: RESEARCH_GAPS.filter((gap) => gaps.has(gap)),
    entities: whoAndWhere(upcoming, [...ownEntities, ...townEntities]),
    hidden: views.filter((view) => view.hidden && view.end >= window.from)
      .map((view) => ({ id: view.id, title: view.title, start: view.start, end: view.end, head: view.head })),
  });
}

// ---- The Competition card ---------------------------------------------------------------------------------------------

const COMPETITION_ROUTE_ID = 'org.competition.get';
/** How far ahead the card lists competitors' events. */
export const COMPETITION_DAYS = 60;

const competitionQuery = z.object({ theme: mapThemeSchema.default('dark') });

/** Why the card has no lettered competitors: no place picked, or Google off or failing. */
export type CompetitionGap = 'no_place' | 'places_off' | null;

export interface CompetitorView {
  readonly letter: string;
  readonly placeId: string;
  readonly name: string;
  readonly type: string;
  readonly distanceM: number;
  /** The pin's place on the map as fractions of its width and height; null without a map. */
  readonly x: number | null;
  readonly y: number | null;
  readonly events: readonly ResearchedEventView[];
}

function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The location's live competitors and its point, or why there are none. */
interface LiveCompetitors {
  readonly gap: CompetitionGap;
  readonly center: LatLng | null;
  readonly competitors: readonly Competitor[];
  /** Each competitor's point, for the map only. */
  readonly points: ReadonlyMap<string, LatLng>;
}

async function liveCompetitors(ctx: TownwiseContext, placeId: string | null): Promise<LiveCompetitors> {
  const none = (gap: CompetitionGap, center: LatLng | null = null): LiveCompetitors => ({ gap, center, competitors: [], points: new Map() });
  if (placeId === null) return none('no_place');
  if (ctx.places === null) return none('places_off');
  const center = await pointOf(ctx, placeId, COMPETITION_ROUTE_ID);
  if (center === null) return none('places_off');
  try {
    const places = await ctx.places.nearby(center, { radiusM: COMPETITOR_RADIUS_M, withWebsite: false });
    return {
      gap: null, center, competitors: pickCompetitors({ ownPlaceId: placeId, center, places }),
      points: new Map(places.map((place) => [place.placeId, { lat: place.lat, lng: place.lng }])),
    };
  } catch (err) {
    if (!(err instanceof PlacesUnavailableError)) throw err;
    ctx.logger.warn({ routeId: COMPETITION_ROUTE_ID, code: err.code, status: err.status, errType: err.errType }, 'townwise.places_failed');
    return none('places_off', center);
  }
}

export async function getCompetition(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const { theme } = parseInput(competitionQuery, req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
  const [live, views, entities] = await Promise.all([
    liveCompetitors(ctx, location.placeId),
    researchedEventsFor(ctx, scope, location, { from: today, to: plusDays(today, COMPETITION_DAYS) }),
    ctx.stores.researchLocations.entities(scope, location.id),
  ]);
  const nameKeys = new Map(entities.map((entity) => [entity.id, { name: entity.name, nameKey: entity.nameKey }]));
  const byPlace = new Map<string, ResearchedEventView[]>();
  const web = new Map<string, ResearchedEventView[]>();
  for (const view of (views ?? []).filter((each) => each.origin === 'competitor')) {
    const entity = view.competitor?.entityId == null ? undefined : nameKeys.get(view.competitor.entityId);
    const placeId = matchCompetitor({ placeId: view.competitor?.placeId ?? null, nameKey: entity?.nameKey ?? null }, live.competitors);
    if (placeId !== null) byPlace.set(placeId, [...byPlace.get(placeId) ?? [], view]);
    else if (entity !== undefined) web.set(entity.name, [...web.get(entity.name) ?? [], view]);
  }
  const lettered = live.competitors.map((competitor, index) => ({ competitor, letter: pinLabel(index) }));
  let map: PlaceMap | null = null;
  let positions: readonly { x: number; y: number }[] = [];
  if (ctx.placesMap !== null && live.center !== null && lettered.length > 0) {
    // The location's own point is in the fit, so the map shows its block; only the competitors carry a letter.
    const at = (competitor: Competitor): LatLng => live.points.get(competitor.placeId) ?? live.center ?? { lat: 0, lng: 0 };
    const view = fitView([live.center, ...lettered.map(({ competitor }) => at(competitor))], STATIC_MAP_WIDTH, STATIC_MAP_HEIGHT);
    map = ctx.placesMap.mapOfView(view, lettered.map(({ competitor, letter }) => ({ at: at(competitor), letter })), theme);
    positions = view.positions.slice(1);
  }
  const competitors: CompetitorView[] = lettered.map(({ competitor, letter }, index) => ({
    letter, placeId: competitor.placeId, name: competitor.name, type: competitor.primaryType, distanceM: Math.round(competitor.distanceM),
    x: positions[index]?.x ?? null, y: positions[index]?.y ?? null, events: byPlace.get(competitor.placeId) ?? [],
  }));
  const webList = [...web.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, events]) => ({ name, events }));
  ctx.logger.info({
    routeId: COMPETITION_ROUTE_ID, competitors: competitors.length, matched: competitors.filter((each) => each.events.length > 0).length, web: webList.length,
  }, 'townwise.competition_read');
  res.status(200).json({ gap: live.gap, map, competitors, web: webList });
}

// ---- Hand edits (design decision 11) ----------------------------------------------------------------------------------

/** The longest `where` a person may type; the title is held to research's own MAX_TITLE_CHARS. */
const MAX_WHERE_CHARS = MAX_TITLE_CHARS;

const basedOnSchema = z.union([z.literal('base'), z.string().regex(/^[0-9a-f]{24}$/)]);
const editFieldsSchema = z.strictObject({
  title: z.string().max(1_000).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().optional(),
  startTime: z.string().regex(TIME).nullable().optional(),
  where: z.string().max(1_000).nullable().optional(),
}).refine((fields) => Object.values(fields).some((value) => value !== undefined));
/** `revert` is TownwiseAI's Undo only, never a person's request. */
const eventUpdateBody = z.union([
  z.strictObject({ op: z.literal('edit'), fields: editFieldsSchema, basedOn: basedOnSchema }),
  z.strictObject({ op: z.enum(['hide', 'restore']), fields: z.null().optional(), basedOn: basedOnSchema }),
]);

const AUDIT_ACTION = { edit: 'research.event_edited', hide: 'research.event_hidden', restore: 'research.event_restored' } as const;

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** 409 `changed_since`, with the event as it is now so the client shows it and can try again from its head. */
function changedSince(res: Response, event: ResearchedEventView | null): void {
  res.status(409).json({ error: 'changed_since', message: 'This event changed since you opened it.', event });
}

/** The edit's fields, checked: `title` and `where` by safeText, and the dates as they would then show by verify's rules. */
function checkedFields(view: ResearchedEventView, input: z.infer<typeof editFieldsSchema>, window: { from: string; to: string }): RevisionFields {
  const title = input.title === undefined ? undefined : safeText(input.title, MAX_TITLE_CHARS);
  if (title === null) throw new AppError(400, 'bad_title', 'That title can’t be used');
  const where = input.where === undefined || input.where === null ? input.where : safeText(input.where, MAX_WHERE_CHARS);
  if (where === null && input.where !== null && input.where !== undefined) throw new AppError(400, 'bad_where', 'That place can’t be used');
  const weekdays = input.weekdays === undefined || input.weekdays === null ? input.weekdays : [...new Set(input.weekdays)].sort((x, y) => x - y);
  const datesChanged = input.start !== undefined || input.end !== undefined || input.weekdays !== undefined;
  // A start the edit keeps is held to no window: research accepted it when found, so an ongoing season's end or weekdays
  // stay editable after its start has passed. A start the person types is held to the window as research's is.
  const startWindow = input.start !== undefined ? window : {
    from: view.start < window.from ? view.start : window.from, to: view.start > window.to ? view.start : window.to,
  };
  if (datesChanged && datesRefused({
    kind: view.kind, startDate: input.start ?? view.start, endDate: input.end ?? view.end,
    weekdays: weekdays === undefined ? (view.weekdays === null ? null : [...view.weekdays]) : weekdays,
  }, startWindow)) {
    throw new AppError(400, 'bad_dates', 'Those dates can’t be used');
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.end !== undefined ? { end: input.end } : {}),
    ...(weekdays !== undefined ? { weekdays } : {}),
    ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
    ...(where !== undefined ? { where } : {}),
  };
}

export async function updateResearchedEvent(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const eventId = String(req.params.eventId);
  // A curated row's or a holiday's id is no researched event: they feed the forecast and are not editable.
  if (parseResearchedId(eventId) === null) throw notFound();
  const input = parseInput(eventUpdateBody, req.body);
  const current = async () => (await readResearchedViews(ctx, scope, location, null)).find((view) => view.id === eventId) ?? null;
  // Research off for the organization, another town's row, another location's or organization's: not found.
  const view = await current();
  if (view === null) throw notFound();
  if (input.basedOn !== view.head) {
    changedSince(res, view);
    return;
  }
  if (await ctx.stores.researchRevisions.count(scope, location.id) >= MAX_LOCATION_REVISIONS) {
    throw new AppError(409, 'too_many_edits', 'This location has too many edits of researched events');
  }
  const op: RevisionOp = input.op;
  const fields = input.op === 'edit' ? checkedFields(view, input.fields, researchWindow(ctx.now(), timeZoneOf(location.town).timeZone)) : null;
  const now = ctx.now();
  const revision = await ctx.stores.researchRevisions.append(scope, {
    locationId: location.id, eventId, op, fields, reverts: null, basedOn: input.basedOn,
    by: { kind: 'person', userId: caller.userId }, now,
  });
  if (revision === null) {
    // Another edit, or TownwiseAI's Undo, took this head first (the unique index).
    changedSince(res, await current());
    return;
  }
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: AUDIT_ACTION[input.op],
    target: { type: 'research_event', id: eventId }, details: { locationId: location.id, eventId },
  });
  res.status(200).json({ event: await current() });
}
