// The slice of TownwiseContext research/read.ts reads (config.research, the organization's switch, the research stores
// and the logger), faked for the unit tests of TownwiseAI's tools (D66 task 5.5). Every event and source is made up.
import type { Logger } from '@ckeith26/server-core';

import type { LocationEventRecord } from '../../src/stores/research-locations.ts';
import type { TownEventRecord } from '../../src/stores/research-towns.ts';

const RUN_ID = '0000000000000000000000f1';

/** A town row of hanover-nh, `t-<id>` once read; `fields` overrides any field. */
export function townRow(id: string, fields: Partial<TownEventRecord> = {}): TownEventRecord {
  return {
    id, townKey: 'hanover-nh', title: 'Green Lantern Walk', titleKey: 'green lantern walk', kind: 'event', category: 'festival',
    start: '2026-11-21', end: '2026-11-21', weekdays: null, startTime: null, status: 'scheduled', venueId: null, hostId: null,
    confidence: 'medium', sources: [{ label: 'example.test', url: 'https://example.test/lantern' }], firstRunId: RUN_ID, lastRunId: RUN_ID,
    firstSeenAt: new Date('2026-11-01T00:00:00Z'), lastSeenAt: new Date('2026-11-10T12:00:00Z'), seenCount: 1, suppressed: null, ...fields,
  };
}

/** The faked reads, research on by default. Spread `stores` into the test's own stores; `warnings` holds any warn. */
export function researchReads(opts: { on?: boolean; town?: readonly TownEventRecord[]; own?: readonly LocationEventRecord[]; fails?: boolean } = {}) {
  const warnings: unknown[] = [];
  const read = <T>(rows: readonly T[] | undefined) => () => (opts.fails === true ? Promise.reject(new Error('down')) : Promise.resolve([...(rows ?? [])]));
  return {
    warnings,
    config: { research: opts.on !== false },
    logger: { warn: (fields: unknown) => { warnings.push(fields); } } as unknown as Logger,
    stores: {
      orgs: { findById: () => Promise.resolve({ research: { on: true, at: null } }) },
      researchTowns: { events: read(opts.town), entities: read([]) },
      researchLocations: { events: read(opts.own), entities: read([]) },
      researchRevisions: { list: read([]) },
    },
  };
}
