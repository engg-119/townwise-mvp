// GET /api/org/locations/:locationId/calendar?from=&to= (spec 10.10, 13.1): the public calendar of the location's
// town, researched town events and US federal holidays, from src/town-calendar.ts. Public data, computed and stored
// nowhere. Location-scoped, so a town outside the twelve still gets its holidays. A read: it logs nothing.
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../dates.ts';
import { townCalendarCovers, townEvents } from '../town-calendar.ts';
import { loadLocation, memberOf } from './locations.ts';

/** How far ahead a range may end, from the server's UTC day. */
const MAX_DAYS_AHEAD = 400;
/** Twenty years. */
const MAX_SPAN_DAYS = 7320;

/** Strict: exactly from and to, from 2010-01-01, from <= to, to at most 400 days ahead, under twenty years. */
function calendarQuery(latest: string) {
  return z.strictObject({ from: isoDate, to: isoDate }).refine((range) =>
    range.from >= EARLIEST_DATE && range.from <= range.to && range.to <= latest && daysBetween(range.from, range.to) < MAX_SPAN_DAYS);
}

export async function getLocationCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const range = parseInput(calendarQuery(utcDay(ctx.now(), MAX_DAYS_AHEAD)), req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const { town } = location;
  const covers = townCalendarCovers(town.townId);
  res.status(200).json({
    town: { townId: town.townId, name: town.name, state: town.state },
    researched: covers !== null,
    covers,
    events: townEvents(town.townId, range),
  });
}
