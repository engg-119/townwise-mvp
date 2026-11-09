// Calibrations from the staff console (forecast lab design call 8): list an organization's calibrations, and start one
// for one of its locations. Both have policy `staff`. A start is a staff action its org admins see in their Townwise
// staff activity (D9): the read-only checks, then calibration.requested (ids and whether a pattern change date was
// given, never a figure), then the effect (spec 9.3). Nothing here publishes; a calibration's job returns a draft.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { scopeForStaffOrg, type Principal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import { isoDate } from '../dates.ts';
import { checkStart, expireStale, launch, START_REFUSAL_WORDS, type StartRefusal, type StartRequest } from '../lab/service.ts';
import { calibrationView } from '../lab/views.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { actorOf, notFound, staffOf } from './admin.ts';

/** The newest calibrations a list shows. */
const LIST_LIMIT = 50;

const startBody = z.strictObject({ regimeStart: isoDate.optional() });

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

/**
 * GET /api/admin/orgs/:orgId/calibrations: 200 { forecasts: { on, at }, calibrations }, the newest 50, a live one past
 * its 20 minutes failed as timeout first.
 */
export async function listCalibrations(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope, org } = await scopeOf(ctx, req, principal);
  const records = await ctx.stores.calibrations.list(scope, LIST_LIMIT);
  const current = await Promise.all(records.map((record) => expireStale(ctx, scope, record)));
  res.status(200).json({
    forecasts: { on: org.forecasts.on, at: org.forecasts.at?.toISOString() ?? null },
    calibrations: current.map(calibrationView),
  });
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
