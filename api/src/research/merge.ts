// A run's merge, the pure half (D66 design decision 8): what the run's recorded threads found, against what the
// subject already stores, becomes a plan of inserts, updates and entity upserts. The runner (task 3.4) applies it and
// is the only writer of researched events and entities; this file reads and writes nothing.
//
// 1. Union the threads' findings and dedupe them (dedupe.ts sameEvent): the higher confidence wins, sources unioned.
// 2. Drop a finding that repeats a curated row (`curated_dupe`), or a `schools` finding on a curated term's first or
//    last day, so term state stays the curated rows' alone; drop a location finding that repeats one of its town's
//    stored rows (`town_dupe`).
// 3. Entities by type and nameKey, across threads, with the stored entity's id when there is one.
// 4. A finding matching a stored row (overlapping dates, title Jaccard at least 0.6) updates it: the run that saw it,
//    how many runs have, its sources and confidence (raised only), and its status, which turns cancelled or postponed
//    only on a finding of at least medium code confidence and at least the row's own. Its title and dates never change.
//    Any other finding is inserted.
//
// The plan is idempotent: a merge redone after a crash matches its own inserts and counts this run once (a row whose
// `lastRunId` is this run keeps its `seenCount`), so a replay inserts and changes nothing.
// [CONFIRM: a finding that repeats a curated row or a curated term date is dropped]
import type { TownEvent } from '../town-calendar.ts';
import { nameKey, sameEvent, storedMatch, titleKey, type Comparable } from './dedupe.ts';
import type { LocationOrigin, ThreadId } from './threads.ts';
import {
  MAX_ENTITY_SOURCES, MAX_EVENT_SOURCES, type Confidence, type EntityType, type EventCategory, type EventKind,
  type EventStatus, type Finding, type FoundEntity, type SourceRef,
} from './verify.ts';

/** One recorded thread's verified answer. */
export interface ThreadFound {
  readonly thread: ThreadId;
  readonly events: readonly Finding[];
  readonly entities: readonly FoundEntity[];
}

/** A stored researched event of the subject (or of the location's town), base values only. */
export interface StoredEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly category: EventCategory;
  readonly status: EventStatus;
  readonly confidence: Confidence;
  readonly sources: readonly SourceRef[];
  readonly seenCount: number;
  readonly lastRunId: string;
  /** Its venue entity's nameKey, or null. */
  readonly venueKey: string | null;
}

export interface StoredEntity { readonly id: string; readonly type: EntityType; readonly nameKey: string }

export interface EntityKey { readonly type: EntityType; readonly nameKey: string }

export interface PlannedEntity {
  readonly key: EntityKey;
  readonly name: string;
  readonly sources: readonly SourceRef[];
  /** The stored entity's id, or null for a new one. */
  readonly id: string | null;
}

export interface PlannedInsert {
  readonly title: string;
  readonly titleKey: string;
  readonly kind: EventKind;
  readonly category: EventCategory;
  readonly start: string;
  readonly end: string;
  readonly weekdays: readonly number[] | null;
  readonly startTime: string | null;
  readonly status: EventStatus;
  readonly confidence: Confidence;
  readonly sources: readonly SourceRef[];
  readonly venue: EntityKey | null;
  readonly host: EntityKey | null;
  readonly thread: ThreadId;
  /** A location row's origin; null on a town row. */
  readonly origin: LocationOrigin | null;
  /** The competitors thread's event: its host business. */
  readonly competitorEntity: EntityKey | null;
  /** Only while Google's names go to Anthropic and the extract named an in-range competitor. */
  readonly competitorPlaceId: string | null;
}

/** A stored row's new values; absent fields never change (title, dates, venue, revisions, suppression). */
export interface PlannedUpdate {
  readonly id: string;
  readonly lastRunId: string;
  readonly seenCount: number;
  readonly sources: readonly SourceRef[];
  readonly confidence: Confidence;
  readonly status: EventStatus;
}

export interface MergeDrops { duplicate: number; curated_dupe: number; town_dupe: number }

export interface MergePlan {
  readonly inserts: readonly PlannedInsert[];
  readonly updates: readonly PlannedUpdate[];
  readonly entities: readonly PlannedEntity[];
  readonly drops: MergeDrops;
  /** Findings across the threads, before any drop. */
  readonly found: number;
}

export interface MergeInput {
  readonly runId: string;
  readonly subject: 'town' | 'location';
  readonly found: readonly ThreadFound[];
  /** The subject's stored rows, suppressed ones included (a merge never clears that). */
  readonly stored: readonly StoredEvent[];
  readonly storedEntities: readonly StoredEntity[];
  /** The town's curated calendar rows over the window (town-calendar.ts townEvents), holidays included. */
  readonly curated: readonly TownEvent[];
  /** A location run: its town's stored rows; a town run: none. */
  readonly townRows: readonly StoredEvent[];
  /** The competitors list's n to its place id, only while Google's names go to Anthropic; else null. */
  readonly competitorPlaces: ReadonlyMap<number, string> | null;
}

const RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

function stronger(a: Confidence, b: Confidence): Confidence {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The sources of `a` then those of `b` not already there, by URL, at most `max`. */
function unionSources(a: readonly SourceRef[], b: readonly SourceRef[], max: number): SourceRef[] {
  const out: SourceRef[] = [];
  for (const source of [...a, ...b]) {
    if (out.length === max) break;
    if (!out.some((kept) => kept.url === source.url)) out.push(source);
  }
  return out;
}

function sameSources(a: readonly SourceRef[], b: readonly SourceRef[]): boolean {
  return a.length === b.length && a.every((source, index) => source.url === b[index]?.url);
}

/** A finding with its thread and its venue and host resolved to entity keys. */
interface Candidate {
  readonly finding: Finding;
  readonly thread: ThreadId;
  readonly venue: EntityKey | null;
  readonly host: EntityKey | null;
  readonly sources: readonly SourceRef[];
}

function comparable(candidate: Candidate): Comparable {
  const { title, start, end, category } = candidate.finding;
  return { title, start, end, category, venueKey: candidate.venue?.nameKey ?? null };
}

function curatedComparable(row: TownEvent): Comparable {
  return { title: row.title, start: row.start, end: row.end, category: null, venueKey: null };
}

function keyOf(key: EntityKey): string {
  return `${key.type}|${key.nameKey}`;
}

function originOf(thread: ThreadId): LocationOrigin | null {
  if (thread === 'competitors') return 'competitor';
  if (thread === 'neighborhood' || thread === 'town_overview') return thread;
  return null;
}

export function planMerge(input: MergeInput): MergePlan {
  const drops: MergeDrops = { duplicate: 0, curated_dupe: 0, town_dupe: 0 };

  // 3. Entities across threads, by type and name key (refs are each thread's own), read first so findings can name them.
  const entities = new Map<string, PlannedEntity>();
  const storedIds = new Map(input.storedEntities.map((entity) => [keyOf(entity), entity.id]));
  const candidates: Candidate[] = [];
  for (const { thread, events, entities: found } of input.found) {
    const byRef = new Map<string, EntityKey>();
    for (const entity of found) {
      const key: EntityKey = { type: entity.type, nameKey: nameKey(entity.name) };
      if (key.nameKey === '') continue;
      byRef.set(entity.ref, key);
      const planned = entities.get(keyOf(key));
      entities.set(keyOf(key), planned === undefined
        ? { key, name: entity.name, sources: entity.sources.slice(0, MAX_ENTITY_SOURCES), id: storedIds.get(keyOf(key)) ?? null }
        : { ...planned, sources: unionSources(planned.sources, entity.sources, MAX_ENTITY_SOURCES) });
    }
    const resolve = (ref: string | null): EntityKey | null => (ref === null ? null : byRef.get(ref) ?? null);
    for (const finding of events) {
      candidates.push({ finding, thread, venue: resolve(finding.venueRef), host: resolve(finding.hostRef), sources: finding.sources });
    }
  }

  // 1. Dedupe across the run: the higher confidence wins, the first on a tie; sources unioned.
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const index = kept.findIndex((other) => sameEvent(comparable(candidate), comparable(other)));
    const other = index === -1 ? undefined : kept[index];
    if (other === undefined) {
      kept.push(candidate);
      continue;
    }
    drops.duplicate += 1;
    const winner = RANK[candidate.finding.confidence] > RANK[other.finding.confidence] ? candidate : other;
    const loser = winner === candidate ? other : candidate;
    kept[index] = { ...winner, sources: unionSources(winner.sources, loser.sources, MAX_EVENT_SOURCES) };
  }

  // 2. Curated rows, curated term days, and (a location run) its town's stored rows.
  const terms = input.curated.filter((row) => row.kind === 'term');
  const fresh = kept.filter((candidate) => {
    const { start, end } = candidate.finding;
    const onTermDay = candidate.thread === 'schools'
      && terms.some((term) => [term.start, term.end].some((day) => day === start || day === end));
    if (onTermDay || input.curated.some((row) => sameEvent(comparable(candidate), curatedComparable(row)))) {
      drops.curated_dupe += 1;
      return false;
    }
    if (input.subject === 'location' && input.townRows.some((row) => sameEvent(comparable(candidate), row))) {
      drops.town_dupe += 1;
      return false;
    }
    return true;
  });

  // 4. Against the subject's stored rows: the best match updates it, no match inserts.
  const updates = new Map<string, { row: StoredEvent; update: PlannedUpdate }>();
  const inserts: PlannedInsert[] = [];
  for (const candidate of fresh) {
    let best: StoredEvent | undefined;
    let bestScore = 0;
    for (const row of input.stored) {
      const score = storedMatch(comparable(candidate), row);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    const { finding } = candidate;
    if (best !== undefined) {
      const row = best;
      const current = updates.get(row.id)?.update ?? {
        id: row.id, lastRunId: input.runId, seenCount: row.lastRunId === input.runId ? row.seenCount : row.seenCount + 1,
        sources: row.sources, confidence: row.confidence, status: row.status,
      };
      const statusChange = finding.status !== 'scheduled' && RANK[finding.codeConfidence] >= RANK.medium
        && RANK[finding.confidence] >= RANK[row.confidence];
      updates.set(row.id, {
        row,
        update: {
          ...current,
          sources: unionSources(current.sources, candidate.sources, MAX_EVENT_SOURCES),
          confidence: stronger(current.confidence, finding.confidence),
          status: statusChange ? finding.status : current.status,
        },
      });
      continue;
    }
    const competitors = candidate.thread === 'competitors';
    inserts.push({
      title: finding.title, titleKey: titleKey(finding.title), kind: finding.kind, category: finding.category,
      start: finding.start, end: finding.end, weekdays: finding.weekdays, startTime: finding.startTime, status: finding.status,
      confidence: finding.confidence, sources: candidate.sources, venue: candidate.venue, host: candidate.host,
      thread: candidate.thread, origin: input.subject === 'location' ? originOf(candidate.thread) : null,
      competitorEntity: competitors && candidate.host?.type === 'business' ? candidate.host : null,
      competitorPlaceId: competitors && input.competitorPlaces !== null && finding.competitor !== null
        ? input.competitorPlaces.get(finding.competitor) ?? null
        : null,
    });
  }

  // A replay changes nothing: an update that would leave its row as stored is left out.
  const changed = [...updates.values()].filter(({ row, update }) => row.lastRunId !== input.runId
    || !sameSources(row.sources, update.sources) || row.confidence !== update.confidence || row.status !== update.status);

  return {
    inserts,
    updates: changed.map(({ update }) => update),
    entities: [...entities.values()],
    drops,
    found: candidates.length,
  };
}
