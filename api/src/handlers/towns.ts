// GET /api/towns/:townId: the public profile of one of the twelve researched towns, for the Town tab (P15), the
// Waiting page (P4) and the Forecast checklist's “Your town” step (P11). Public data only; no client data.
import { AppError } from '@ckeith26/server-core';
import type { Request, Response } from 'express';

import type { TownwiseContext } from '../app.ts';
import {
  CAVEATS, INDEX_DEFINITION, NORTHEAST, SOURCES, TOWN_DATA_YEAR, TOWN_PROFILES,
  type CountySeries, type Driver, type KeyDate, type Series, type Source,
} from '../town-profiles.ts';
import { TOWNS, type TownRecord } from '../towns.ts';

export interface TownProfile extends TownRecord {
  anchor: string; note: string;
  /** The county the employment series covers: county, not town. */
  county: string;
  year: number;
  series: CountySeries; northeast: Series;
  drivers: readonly Driver[]; dates: readonly KeyDate[];
  caveats: readonly string[]; indexDefinition: string; sources: readonly Source[];
}

const PROFILES: ReadonlyMap<string, TownProfile> = new Map(TOWNS.flatMap((town) => {
  const data = TOWN_PROFILES.find((profile) => profile.townId === town.townId);
  if (data === undefined) return [];
  return [[town.townId, {
    ...town, anchor: data.anchor, note: data.note, county: data.county, year: TOWN_DATA_YEAR,
    series: data.series, northeast: NORTHEAST, drivers: data.drivers, dates: data.dates,
    caveats: CAVEATS, indexDefinition: INDEX_DEFINITION, sources: SOURCES,
  }] as const];
}));

/** Any signed-in person may read it: a requester sees their town on Waiting before any organization exists. */
export function getTownProfile(_ctx: TownwiseContext, req: Request, res: Response): Promise<void> {
  const { townId } = req.params;
  const profile = typeof townId === 'string' ? PROFILES.get(townId) : undefined;
  if (profile === undefined) return Promise.reject(new AppError(404, 'not_found', 'Not found'));
  res.status(200).json({ profile });
  return Promise.resolve();
}
