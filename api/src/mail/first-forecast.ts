// D65 (openspec change forecast-training-status, design decision 9): the one email org admins get when a location's
// first forecast is published, by the lab's gate or by staff. It runs after the publish has applied and nothing else of
// it is left, and it never throws, so a failed read, a lost claim or a failed send cannot change, delay or fail the
// publish, the calibration's finish or the route's answer. At most once per location: the recipients are found first,
// then tw_locations.firstForecastMailedAt is claimed by compare-and-set, and only the winner sends, so a retried or
// concurrent publish sends nothing more, and a crash between the claim and the send loses the email rather than sending
// it twice. With no joined admin, or with email off, nothing is claimed. Logs carry the organization and location ids.
import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { OFF_MAILER } from './mailer.ts';

/**
 * Emails every active org admin of the organization, once per location, when `runId` is published and is the
 * location's first run ever published (a run that was published and later withdrawn still counts, so a republish is
 * not "first"). Resolves when the sends are queued; never rejects.
 */
export async function mailFirstForecast(
  ctx: Pick<TownwiseContext, 'stores' | 'authStores' | 'mailer' | 'logger' | 'now'>, scope: OrgScope, locationId: string, runId: string,
): Promise<void> {
  try {
    if (ctx.mailer === OFF_MAILER) return;
    const { forecasts, locations, members, orgs } = ctx.stores;
    const run = await forecasts.find(scope, runId);
    if (run?.status !== 'published' || run.locationId !== locationId) return;
    if ((await forecasts.firstPublished(scope, locationId))?.runId !== runId) return;
    const [location, org] = await Promise.all([locations.find(scope, locationId), orgs.findById(scope.orgId)]);
    if (location === null || org === null) return;
    const userIds = (await members.list(scope)).flatMap((seat) => (seat.role === 'org_admin' && seat.status === 'active' ? [seat.userId] : []));
    const users = await Promise.all(userIds.map((userId) => ctx.authStores.users.findById(userId)));
    // A deleted user is skipped; an invitation has no user (a staff-set-up organization nobody has joined, D25).
    const addresses = users.flatMap((user) => (user == null ? [] : [user.email]));
    if (addresses.length === 0) return;
    if (!(await locations.claimFirstForecastMail(scope, locationId, ctx.now()))) return;
    const email = { kind: 'first_forecast', orgName: org.name, locationName: location.name, town: location.town } as const;
    for (const address of addresses) ctx.mailer.send(email, address, { orgId: scope.orgId, locationId });
  } catch {
    // The error itself never reaches the log: it may carry a query with an address in it.
    ctx.logger.warn({ orgId: scope.orgId, locationId }, 'townwise.first_forecast_mail_failed');
  }
}
