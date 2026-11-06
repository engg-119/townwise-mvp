// Estimates (spec 10.13, docs/portal/estimates.md): people in town for a range of days, "How Townwise estimates"
// for a location, and (U13B) its published forecast for a range of days. Member GETs with no body and no route
// limiter, allowed under view-as (the chain logs townwise.view_as_read). Public town data, the organization's own
// days and notes, and the forecast runs staff published for it; drafts and withdrawn runs never show. None of these
// handlers logs or audits anything.
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../dates.ts';
import { estimatesAbout } from '../estimates/about.ts';
import { MAX_FORECAST_RANGE_DAYS } from '../forecasts/reader.ts';
import { MAX_PEOPLE_RANGE_DAYS } from '../people-in-town/estimate.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { loadLocation, memberOf } from './locations.ts';

/** How far ahead a range may end, from the server's UTC day (as the calendar route). */
const MAX_DAYS_AHEAD = 400;

/** Strict: exactly from and to, from 2010-01-01, from <= to, at most 92 days, to at most 400 days ahead. */
function peopleQuery(latest: string) {
  return z.strictObject({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from <= range.to
    && daysBetween(range.from, range.to) < MAX_PEOPLE_RANGE_DAYS && range.to <= latest);
}

/** GET /api/org/locations/:locationId/people-in-town?from=&to=: 200 PeopleInTownWindow. */
export async function getPeopleInTown(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const range = parseInput(peopleQuery(utcDay(ctx.now(), MAX_DAYS_AHEAD)), req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  res.status(200).json(await ctx.ports.peopleInTown.window({ scope, location, range }));
}

/** GET /api/org/locations/:locationId/estimates/about: 200 EstimatesAbout. */
export async function getEstimatesAbout(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const now = ctx.now();
  // U13B: the newest published run and its own live accuracy; none until staff publish one. Today is the town's, as
  // TownwiseAI's, so the card and the chat score the same days.
  const forecast = await ctx.ports.forecasts.latest(scope, location.id, localDay(now, timeZoneOf(location.town).timeZone));
  res.status(200).json(estimatesAbout(location, ctx.ports.peopleInTown.data, now, forecast));
}

/** U13B: how far back a forecast read may start, from the server's UTC day. */
const MAX_FORECAST_DAYS_BACK = 400;

/** U13B: strict, as the people in town query, but at most 31 days and from at most 400 days back. */
function forecastQuery(earliest: string, latest: string) {
  return z.strictObject({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from >= earliest
    && range.from <= range.to && daysBetween(range.from, range.to) < MAX_FORECAST_RANGE_DAYS && range.to <= latest);
}

/** U13B: GET /api/org/locations/:locationId/forecast?from=&to=: 200 ForecastWindow, published runs only. */
export async function getForecast(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const now = ctx.now();
  const range = parseInput(forecastQuery(utcDay(now, -MAX_FORECAST_DAYS_BACK), utcDay(now, MAX_DAYS_AHEAD)), req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  // Today is the town's, as for the model card and TownwiseAI: a day counts as past only once it has ended there.
  res.status(200).json(await ctx.ports.forecasts.window(scope, location, range, localDay(now, timeZoneOf(location.town).timeZone)));
}
