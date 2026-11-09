// Staff setup (D23, F10b, spec 10.7): while an organization is active and nobody has ever held a seat in it (open
// invitations don't count), Townwise staff add, rename and remove its locations and upload or delete its daily totals,
// so the first admin who joins finds a populated page. It ends at the first join for good: an organization whose
// members all left is a former client's, and no admin would be there to see a staff write in their activity. Every route here has policy `staff` and scopes through scopeForStaffOrg. The
// body checks and the writes are the org routes' own (locations.ts, sales.ts); a staff upload replaces the days it
// covers, as an org admin's does. Each write is a staff action its org admins see in their Townwise staff activity once
// they join (D9): read-only checks, then the event, then the effect (spec 9.3). Records written here hold the staff
// user id with `byStaff`, so every client view names them “Townwise staff”. Answers carry ids, names, towns, counts and
// date coverage, never a figure: staff still read values only through view-as (D7).
//
// Setup is checked before the event, with no lock. A join landing between the check and the write is accepted: the
// write is still recorded, and the new admin sees it in their staff activity.
import { objectId } from '@ckeith26/mongo';
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForStaffOrg, type OrgScope, type Principal, type StaffPrincipal } from '../access/policy.ts';
import { isInSetup, notInSetup } from '../access/setup.ts';
import { TOWNWISE_STAFF } from '../people.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { actorOf, notFound, staffOf } from './admin.ts';
import {
  assertNoLocationData, checkedCreate, checkedUpdate, loadLocation, locationDetails, nameTaken, removeLocation, summarizer,
  type LocationChange, type LocationInput,
} from './locations.ts';
import { applyUpload, assertNotReading, checkedUpload, filesUnavailable, removeSalesData, uploadAnswer } from './sales.ts';

/**
 * The organization in the path (404 when unknown), refused with 409 org_not_in_setup while it is suspended and once
 * anyone has ever joined it (isInSetup, which the console's `inSetup` reads too).
 */
async function setupScope(ctx: TownwiseContext, req: Request, principal: Principal): Promise<{ staff: StaffPrincipal; scope: OrgScope }> {
  const staff = staffOf(principal);
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  if (!(await isInSetup(ctx, scope, org))) throw notInSetup();
  return { staff, scope };
}

function eventOf(staff: StaffPrincipal, scope: OrgScope, at: Date, fields: Pick<AuditEventInput, 'action' | 'target' | 'details'>): AuditEventInput {
  return { ...actorOf(staff), at, orgId: scope.orgId, ...fields };
}

/** The location as a PATCH leaves it. */
function changed(location: LocationRecord, change: LocationChange): LocationInput {
  return {
    name: change.name ?? location.name,
    town: change.town ?? location.town,
    placeId: change.placeId === undefined ? location.placeId : change.placeId,
  };
}

/** POST /api/admin/orgs/:orgId/locations, as POST /api/org/locations: 201 { location }. */
export async function createSetupLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await setupScope(ctx, req, principal);
  const input = await checkedCreate(ctx, scope, 'admin.orgs.locations.create', staff.actor.userId, req.body);
  const id = new Types.ObjectId().toHexString();
  const now = ctx.now();
  const event = eventOf(staff, scope, now, {
    action: 'location.created', target: { type: 'location', id }, details: locationDetails(input),
  });
  const eventId = await recordBefore(ctx, event);
  const location = await applyRecorded(ctx, event, eventId, () => ctx.stores.locations.create(scope, {
    id, ...input, createdAt: now, createdBy: staff.actor.userId, byStaff: true,
  }));
  if (location === null) {
    await recordNotApplied(ctx, event, eventId, 'location_name_taken');
    throw nameTaken();
  }
  const summarize = await summarizer(ctx, scope);
  res.status(201).json({ location: summarize(location) });
}

/** PATCH /api/admin/orgs/:orgId/locations/:locationId, as PATCH /api/org/locations/:locationId: 200 { location }. */
export async function updateSetupLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await setupScope(ctx, req, principal);
  const { location, change } = await checkedUpdate(
    ctx, scope, 'admin.orgs.locations.update', staff.actor.userId, req.params.locationId, req.body,
  );
  const event = eventOf(staff, scope, ctx.now(), {
    action: 'location.updated', target: { type: 'location', id: location.id }, details: locationDetails(changed(location, change)),
  });
  const eventId = await recordBefore(ctx, event);
  const outcome = await applyRecorded(ctx, event, eventId, () => ctx.stores.locations.update(scope, location.id, change));
  if (outcome !== 'updated') {
    await recordNotApplied(ctx, event, eventId, outcome === 'name_taken' ? 'location_name_taken' : 'not_found');
    throw outcome === 'name_taken' ? nameTaken() : notFound();
  }
  const updated = await ctx.stores.locations.find(scope, location.id);
  if (updated === null) throw notFound();
  const summarize = await summarizer(ctx, scope);
  res.status(200).json({ location: summarize(updated) });
}

/** DELETE /api/admin/orgs/:orgId/locations/:locationId, as DELETE /api/org/locations/:locationId: 204. */
export async function deleteSetupLocation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await setupScope(ctx, req, principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  await assertNoLocationData(ctx, scope, location.id);
  const event = eventOf(staff, scope, ctx.now(), {
    action: 'location.deleted', target: { type: 'location', id: location.id },
    details: { name: location.name, townId: location.town.townId },
  });
  const eventId = await recordBefore(ctx, event);
  if (!(await applyRecorded(ctx, event, eventId, () => removeLocation(ctx, scope, location.id)))) {
    await recordNotApplied(ctx, event, eventId, 'not_found');
    throw notFound();
  }
  res.status(204).end();
}

/**
 * POST /api/admin/orgs/:orgId/locations/:locationId/sales/uploads, the body of the org route: 201 { upload, coverage,
 * calibration }, replacing the days it covers, with the uploader “Townwise staff”. The event is written before the
 * days, so it carries no `inserted` or `replaced`, which exist only after.
 */
export async function uploadSetupSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await setupScope(ctx, req, principal);
  const now = ctx.now();
  const checked = checkedUpload(req.body, now);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const id = new Types.ObjectId().toHexString();
  const event = eventOf(staff, scope, now, {
    action: 'sales.uploaded', target: { type: 'upload', id },
    details: { locationId: location.id, dayCount: checked.days.length, firstDate: checked.firstDate, lastDate: checked.lastDate },
  });
  const eventId = await recordBefore(ctx, event);
  const applied = await applyRecorded(ctx, event, eventId, () => applyUpload(ctx, scope, location.id, {
    ...checked, id, replace: true, uploadedBy: staff.actor.userId, byStaff: true, now,
  }));
  res.status(201).json(await uploadAnswer(ctx, scope, location.id, applied, TOWNWISE_STAFF));
}

/**
 * DELETE /api/admin/orgs/:orgId/locations/:locationId/sales, as the org route: 200 { deletedDays, deletedUploads,
 * deletedFiles }. The event is written before the delete, so its `deletedDays` counts the days with a value then, and
 * it carries no `deletedFiles`.
 */
export async function deleteSetupSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await setupScope(ctx, req, principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  await assertNotReading(ctx, scope, location.id);
  const { dayCount } = await ctx.stores.salesDays.coverage(scope, location.id);
  const event = eventOf(staff, scope, ctx.now(), {
    action: 'sales.deleted', target: { type: 'location', id: location.id }, details: { locationId: location.id, deletedDays: dayCount },
  });
  const eventId = await recordBefore(ctx, event);
  const removed = await applyRecorded(ctx, event, eventId, () => removeSalesData(ctx, scope, location.id));
  if (removed === 'files_unavailable') {
    await recordNotApplied(ctx, event, eventId, 'files_unavailable');
    throw filesUnavailable();
  }
  res.status(200).json(removed);
}
