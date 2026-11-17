// Calibrations from the staff console (forecast lab design call 8): list an organization's calibrations, start one for
// one of its locations, and switch the organization's forecasts on or off (G1). Each has policy `staff`. A start and a
// switch are staff actions its org admins see in their Townwise staff activity (D9): the read-only checks, then the
// event (ids, whether a pattern change date was given, on or off; never a figure), then the effect (spec 9.3). Nothing
// here publishes: a calibration's job returns a draft, which the system publishes only while forecasts are on. The
// weekly refresh (D42) shows here too: the list carries the schedule's state and each location's latest week row, and
// staff pause or resume every scheduled start (POST /api/admin/forecast-schedule), audited with no organization.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { scopeForStaffOrg, type Principal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import { isoDate, utcDay } from '../dates.ts';
import { checkStart, expireStale, launch, START_REFUSAL_WORDS, type StartRefusal, type StartRequest } from '../lab/service.ts';
import { WEEK_ROWS_LOOKBACK_DAYS } from '../lab/schedule.ts';
import { calibrationView } from '../lab/views.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { ForecastWeekRecord } from '../stores/forecast-weeks.ts';
import type { SchedulePause } from '../stores/forecast-schedule.ts';
import type { OrgRecord } from '../stores/orgs.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { actorOf, notFound, staffOf } from './admin.ts';

/** The newest calibrations a list shows. */
const LIST_LIMIT = 50;

const startBody = z.strictObject({ regimeStart: isoDate.optional() });
/** Switching on carries the staff member's word that the organization's owner agreed (G1). */
const switchBody = z.discriminatedUnion('on', [
  z.strictObject({ on: z.literal(true), ownerAgreed: z.literal(true) }),
  z.strictObject({ on: z.literal(false) }),
]);
const scheduleBody = z.strictObject({ paused: z.boolean() });

/** Each refusal's status and error code; the message is its words. */
const REFUSALS: Readonly<Record<StartRefusal, { status: number; code: string }>> = {
  lab_unavailable: { status: 503, code: 'lab_unavailable' },
  not_enough_history: { status: 409, code: 'not_enough_history' },
  invalid_regime_start: { status: 400, code: 'invalid_regime_start' },
  budget_exhausted: { status: 409, code: 'chat_budget_exhausted' },
  in_progress: { status: 409, code: 'calibration_in_progress' },
  rate_limited: { status: 429, code: 'calibrations_rate_limited' },
  start_failed: { status: 503, code: 'lab_start_failed' },
};

function refused(refusal: StartRefusal): AppError {
  const { status, code } = REFUSALS[refusal];
  return new AppError(status, code, START_REFUSAL_WORDS[refusal]);
}

async function scopeOf(ctx: TownwiseContext, req: Request, principal: Principal) {
  const staff = staffOf(principal);
  return { staff, ...(await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId))) };
}

/** `at` is null for an organization nobody switched, which reads as on (D42): the console says "On (default)". */
function forecastsView(org: OrgRecord): { on: boolean; at: string | null } {
  return { on: org.forecasts.on, at: org.forecasts.at?.toISOString() ?? null };
}

/** The weekly refresh as staff see it (D42): whether it runs at all (the lab runner and TOWNWISE_WEEKLY_FORECASTS), and the pause. */
interface ScheduleView { running: boolean; paused: { at: string; email: string } | null }

function scheduleView(ctx: TownwiseContext, paused: SchedulePause | null): ScheduleView {
  return {
    running: ctx.labRunner !== null && ctx.config.weeklyForecasts,
    paused: paused === null ? null : { at: paused.at.toISOString(), email: paused.email },
  };
}

function weekView(row: ForecastWeekRecord): { locationId: string; week: string; outcome: string; calibrationId: string | null } {
  return { locationId: row.locationId, week: row.week, outcome: row.status, calibrationId: row.calibrationId };
}

/**
 * GET /api/admin/orgs/:orgId/calibrations: 200 { forecasts: { on, at }, schedule: { running, paused }, weeks,
 * calibrations }, the newest 50 calibrations, a live one past its 20 minutes failed as timeout first, and each location's
 * latest week row of the last 8 weeks (D42).
 */
export async function listCalibrations(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope, org } = await scopeOf(ctx, req, principal);
  const records = await ctx.stores.calibrations.list(scope, LIST_LIMIT);
  const current = await Promise.all(records.map((record) => expireStale(ctx, scope, record)));
  const since = utcDay(ctx.now(), -WEEK_ROWS_LOOKBACK_DAYS);
  const [paused, weeks] = await Promise.all([ctx.stores.forecastSchedule.paused(), ctx.stores.forecastWeeks.latestByLocation(scope, since)]);
  res.status(200).json({
    forecasts: forecastsView(org), schedule: scheduleView(ctx, paused), weeks: weeks.map(weekView), calibrations: current.map(calibrationView),
  });
}

/**
 * POST /api/admin/forecast-schedule { paused } (D42): 200 { schedule: { running, paused } }. Pauses or resumes every
 * scheduled start of the weekly refresh, for all organizations, from the next pass; a calibration already live goes on.
 * A staff action recorded before the effect (forecast_schedule.paused or .resumed, no organization, no details); the
 * schedule already in that state changes and records nothing.
 */
export async function setForecastSchedule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { paused } = parseInput(scheduleBody, req.body);
  const now = ctx.now();
  if (((await ctx.stores.forecastSchedule.paused()) !== null) !== paused) {
    const event: AuditEventInput = {
      ...actorOf(staff), at: now, orgId: null, action: paused ? 'forecast_schedule.paused' : 'forecast_schedule.resumed',
      target: { type: 'forecast_schedule', id: 'weekly' }, details: {},
    };
    const eventId = await recordBefore(ctx, event);
    await applyRecorded(ctx, event, eventId, () => ctx.stores.forecastSchedule.setPaused(
      paused ? { at: now, by: staff.actor.userId, email: staff.actor.email } : null, now,
    ));
  }
  res.status(200).json({ schedule: scheduleView(ctx, await ctx.stores.forecastSchedule.paused()) });
}

/**
 * POST /api/admin/orgs/:orgId/forecasts-switch { on: true, ownerAgreed: true } | { on: false } (G1): 200 { forecasts:
 * { on, at } }; 400 invalid_request for on without ownerAgreed true. The switch already in that position changes and
 * records nothing. While it is off, nothing is published, by staff or by a calibration; switching it off leaves runs
 * already published as they are.
 */
export async function switchForecasts(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope, org } = await scopeOf(ctx, req, principal);
  const { on } = parseInput(switchBody, req.body);
  if (org.forecasts.on !== on) {
    const now = ctx.now();
    const event: AuditEventInput = {
      ...actorOf(staff), at: now, orgId: scope.orgId, action: 'org.forecasts_switched', target: { type: 'org', id: scope.orgId },
      details: { on },
    };
    const eventId = await recordBefore(ctx, event);
    if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.orgs.setForecasts(scope, { on, at: now, by: staff.actor.userId })))) {
      await recordNotApplied(ctx, event, eventId, 'not_found');
      throw notFound();
    }
  }
  const current = await ctx.stores.orgs.findById(scope.orgId);
  if (current === null) throw notFound();
  res.status(200).json({ forecasts: forecastsView(current) });
}

/**
 * POST /api/admin/orgs/:orgId/locations/:locationId/calibrations { regimeStart?: date }: 201 { calibration }, running.
 * 400 invalid_regime_start; 409 calibration_in_progress, not_enough_history or chat_budget_exhausted; 429
 * calibrations_rate_limited; 503 lab_unavailable or lab_start_failed. A refusal after the event is recorded
 * (another start won the location, or the day's 4 were used) also records that it did not take effect.
 */
export async function startCalibration(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await scopeOf(ctx, req, principal);
  const location = await ctx.stores.locations.find(scope, parseInput(objectId, req.params.locationId));
  if (location === null) throw notFound();
  const body = parseInput(startBody, req.body);
  const request: StartRequest = {
    id: new Types.ObjectId().toHexString(), scope, location,
    requester: { userId: staff.actor.userId, role: 'superadmin', via: 'console' },
    regimeStart: body.regimeStart ?? null,
    today: localDay(ctx.now(), timeZoneOf(location.town).timeZone),
  };
  const refusal = await checkStart(ctx, request);
  if (refusal !== null) throw refused(refusal);
  const event: AuditEventInput = {
    ...actorOf(staff), at: ctx.now(), orgId: scope.orgId, action: 'calibration.requested',
    target: { type: 'calibration', id: request.id },
    details: { locationId: location.id, calibrationId: request.id, via: 'console', hasRegime: request.regimeStart !== null },
  };
  const eventId = await recordBefore(ctx, event);
  const launched = await applyRecorded(ctx, event, eventId, () => launch(ctx, request));
  if (!launched.ok) {
    if (launched.code === 'in_progress') await recordNotApplied(ctx, event, eventId, 'calibration_in_progress');
    if (launched.code === 'rate_limited') await recordNotApplied(ctx, event, eventId, 'calibrations_rate_limited');
    throw refused(launched.code);
  }
  res.status(201).json({ calibration: calibrationView(launched.calibration) });
}
