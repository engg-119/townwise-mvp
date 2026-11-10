import type { z } from 'zod';

import type { ApiClient, RequestOptions } from '../../../src/api/client';
import {
  addOrgMembers, approveRequest, changeOrgMemberRole, createOrg, createSetupLocation, deleteOrg, deletePerson, deleteSetupLocation,
  deleteSetupSales, fetchAudit, fetchOrg, fetchOrgs, fetchPeople, fetchRequests, lookupPerson, rejectRequest, removeOrgMember,
  signOutEverywhere, startViewAs, updateOrg, updateSetupLocation, uploadSetupSales,
} from '../../../src/portal/console/api';
import {
  auditEventSchema, orgDetailSchema, orgLocationSchema, setupLocationSchema, setupUploadSchema,
} from '../../../src/portal/console/schemas';
import { staffMe } from '../../helpers/portal';
import { adminRequest, auditEvent, emailOf, member, orgDetail, orgRow, person } from './fixtures';

// Every staff console call (src/portal/console/api.ts): its method, path and body against the API's route
// table (api/src/access/routes.ts), and the schemas' promise that no figure or note text gets through (D7).

interface Sent { method: string; path: string; body: unknown }

function recorder(answer: unknown): { api: ApiClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const record = (path: string, opts?: RequestOptions): void => { sent.push({ method: opts?.method ?? 'GET', path, body: opts?.body }); };
  const api: ApiClient = {
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      record(path, opts);
      return Promise.resolve(schema.parse(answer));
    },
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      record(path, opts);
      return Promise.resolve({ ok: true, status: 204 } as unknown as Response);
    },
    stream: () => Promise.reject(new Error('not used')),
    logout: () => Promise.resolve(),
  };
  return { api, sent };
}

const EMAIL = emailOf('cook');
const REQUEST = adminRequest();
const TOWN = { townId: 'hanover-nh' };
const DAYS = [{ date: '2026-03-04', guests: 120, netSalesCents: 100_025 }];
const SETUP_LOCATION = { location: { id: 'l1', name: 'Hanover' } };
const SETUP_UPLOAD = {
  upload: { dayCount: 1, firstDate: '2026-03-04', lastDate: '2026-03-04' },
  coverage: { dayCount: 1, firstDate: '2026-03-04', lastDate: '2026-03-04' },
};

test.each<[string, unknown, (api: ApiClient) => Promise<unknown>, Sent]>([
  ['requests by status', { requests: [REQUEST], pendingCount: 1 }, (api) => fetchRequests(api, 'withdrawn'),
    { method: 'GET', path: '/api/admin/requests?status=withdrawn', body: undefined }],
  ['approve', { org: { id: 'o9', name: 'Tavern' }, request: REQUEST }, (api) => approveRequest(api, 'r1', { orgName: 'Tavern', locationName: 'Main' }),
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Tavern', locationName: 'Main' } }],
  ['approve with places', { org: { id: 'o9', name: 'Tavern' }, request: REQUEST }, (api) => approveRequest(api, 'r1', { orgName: 'Tavern', locationNames: ['Main', 'Elm'] }),
    { method: 'POST', path: '/api/admin/requests/r1/approve', body: { orgName: 'Tavern', locationNames: ['Main', 'Elm'] } }],
  ['reject with a message', { request: REQUEST }, (api) => rejectRequest(api, 'r1', 'Not yet.'),
    { method: 'POST', path: '/api/admin/requests/r1/reject', body: { message: 'Not yet.' } }],
  ['reject without one', { request: REQUEST }, (api) => rejectRequest(api, 'r1', ''),
    { method: 'POST', path: '/api/admin/requests/r1/reject', body: {} }],
  ['organizations', { orgs: [orgRow('o1', 'A')] }, (api) => fetchOrgs(api),
    { method: 'GET', path: '/api/admin/orgs', body: undefined }],
  ['create an organization', { org: { id: 'o9', name: 'A' }, result: { email: EMAIL, outcome: 'invited' } },
    (api) => createOrg(api, { id: 'a'.repeat(24), name: 'A', adminEmail: EMAIL }),
    { method: 'POST', path: '/api/admin/orgs', body: { id: 'a'.repeat(24), name: 'A', adminEmail: EMAIL } }],
  ['an organization', orgDetail(), (api) => fetchOrg(api, 'o1'),
    { method: 'GET', path: '/api/admin/orgs/o1', body: undefined }],
  ['rename', { org: orgDetail().org }, (api) => updateOrg(api, 'o1', { name: 'B' }),
    { method: 'PATCH', path: '/api/admin/orgs/o1', body: { name: 'B' } }],
  ['suspend', { org: orgDetail().org }, (api) => updateOrg(api, 'o1', { status: 'suspended' }),
    { method: 'PATCH', path: '/api/admin/orgs/o1', body: { status: 'suspended' } }],
  ['delete an organization', { deletedLocations: 1 }, (api) => deleteOrg(api, 'o1'),
    { method: 'DELETE', path: '/api/admin/orgs/o1', body: undefined }],
  ['add members', { results: [], members: [] }, (api) => addOrgMembers(api, 'o1', { emails: [EMAIL], role: 'member' }),
    { method: 'POST', path: '/api/admin/orgs/o1/members', body: { emails: [EMAIL], role: 'member' } }],
  ['change a role', { member: member('m1', EMAIL) }, (api) => changeOrgMemberRole(api, 'o1', 'm1', 'org_admin'),
    { method: 'PATCH', path: '/api/admin/orgs/o1/members/m1', body: { role: 'org_admin' } }],
  ['remove a member', null, (api) => removeOrgMember(api, 'o1', 'm1'),
    { method: 'DELETE', path: '/api/admin/orgs/o1/members/m1', body: undefined }],
  ['people', { people: [], truncated: false }, (api) => fetchPeople(api, null),
    { method: 'GET', path: '/api/admin/people', body: undefined }],
  ['people of a kind', { people: [], truncated: false }, (api) => fetchPeople(api, 'signed_in'),
    { method: 'GET', path: '/api/admin/people?kind=signed_in', body: undefined }],
  ['lookup, the email only in q, encoded', { person: null }, (api) => lookupPerson(api, 'a+b@example.com'),
    { method: 'GET', path: '/api/admin/people/lookup?q=a%2Bb%40example.com', body: undefined }],
  ['sign out everywhere', { revoked: 2 }, (api) => signOutEverywhere(api, 'u1'),
    { method: 'POST', path: '/api/admin/people/u1/sign-out-everywhere', body: {} }],
  ['delete a person, the email in the body', { deletedRequests: 0, deletedSeats: 0, redactedEvents: 0, kitUserId: null },
    (api) => deletePerson(api, EMAIL), { method: 'POST', path: '/api/admin/people/delete', body: { email: EMAIL } }],
  ['the audit log', { events: [], nextBefore: null }, (api) => fetchAudit(api, {}),
    { method: 'GET', path: '/api/admin/audit', body: undefined }],
  ['the audit log, filtered and paged, empty filters left out', { events: [], nextBefore: null },
    (api) => fetchAudit(api, { orgId: 'o1', actorUserId: '', action: 'org.renamed', before: '2026-10-09T15:00:00.000Z' }),
    { method: 'GET', path: '/api/admin/audit?orgId=o1&action=org.renamed&before=2026-10-09T15%3A00%3A00.000Z', body: undefined }],
  ['start view-as', staffMe(), (api) => startViewAs(api, 'u2', 'Helping.'),
    { method: 'POST', path: '/api/admin/view-as', body: { userId: 'u2', reason: 'Helping.' } }],
  ['setup: add a location', SETUP_LOCATION, (api) => createSetupLocation(api, 'o1', { name: 'Hanover', town: TOWN }),
    { method: 'POST', path: '/api/admin/orgs/o1/locations', body: { name: 'Hanover', town: TOWN } }],
  ['setup: add a location at a place', SETUP_LOCATION, (api) => createSetupLocation(api, 'o1', { name: 'Hanover', town: TOWN, placeId: 'p1' }),
    { method: 'POST', path: '/api/admin/orgs/o1/locations', body: { name: 'Hanover', town: TOWN, placeId: 'p1' } }],
  ['setup: rename a location', SETUP_LOCATION, (api) => updateSetupLocation(api, 'o1', 'l1', { name: 'Inn', town: TOWN }),
    { method: 'PATCH', path: '/api/admin/orgs/o1/locations/l1', body: { name: 'Inn', town: TOWN } }],
  ['setup: delete a location', null, (api) => deleteSetupLocation(api, 'o1', 'l1'),
    { method: 'DELETE', path: '/api/admin/orgs/o1/locations/l1', body: undefined }],
  ['setup: upload daily totals', SETUP_UPLOAD, (api) => uploadSetupSales(api, 'o1', 'l1', { days: DAYS }),
    { method: 'POST', path: '/api/admin/orgs/o1/locations/l1/sales/uploads', body: { days: DAYS } }],
  ['setup: delete sales data', { deletedDays: 1, deletedUploads: 1, deletedFiles: 0 }, (api) => deleteSetupSales(api, 'o1', 'l1'),
    { method: 'DELETE', path: '/api/admin/orgs/o1/locations/l1/sales', body: undefined }],
])('%s', async (_name, answer, call, expected) => {
  const { api, sent } = recorder(answer);
  await call(api);
  expect(sent).toEqual([expected]);
});

test('ids are encoded into paths', async () => {
  const { api, sent } = recorder({ org: orgDetail().org });
  await updateOrg(api, 'o/1?x', { name: 'B' });
  expect(sent[0]?.path).toBe('/api/admin/orgs/o%2F1%3Fx');
  await deleteSetupLocation(api, 'o/1', 'l?1');
  expect(sent[1]?.path).toBe('/api/admin/orgs/o%2F1/locations/l%3F1');
});

test('setup answers keep ids, names, day counts and dates only: no calibration, no figure (D7)', () => {
  const upload = setupUploadSchema.parse({
    upload: { ...SETUP_UPLOAD.upload, id: 'up1', inserted: 1, replaced: 0, kept: 0, uploadedByEmail: 'Townwise staff', hasGuests: true },
    coverage: { ...SETUP_UPLOAD.coverage, guestsDayCount: 1, netSalesDayCount: 1, missingDays: 0, netSalesCents: 98765400 },
    calibration: { state: 'not_calibrated', dayCount: 1, firstDate: '2026-03-04', lastDate: '2026-03-04' },
  });
  expect(upload).toEqual(SETUP_UPLOAD);
  const location = setupLocationSchema.parse({
    location: { id: 'l1', name: 'Hanover', town: TOWN, coverage: { dayCount: 1, netSalesCents: 98765400 }, calibration: { state: 'no_sales_data' } },
  });
  expect(location).toEqual(SETUP_LOCATION);
  expect(orgDetailSchema.parse(orgDetail({ org: { inSetup: true } })).org.inSetup).toBe(true);
});

test('the console keeps only what it shows: no figure or note text gets past the schemas (D7)', () => {
  const location = orgLocationSchema.parse({
    ...orgDetail().locations[0],
    coverage: { dayCount: 1, firstDate: null, lastDate: null, guestsDayCount: 1, netSalesCents: 98765400, guests: 43210 },
    netSalesCents: 98765400,
    notes: [{ detail: 'Private party' }],
  });
  expect(location.coverage).toEqual({ dayCount: 1, firstDate: null, lastDate: null });
  expect(Object.keys(location).sort()).toEqual(['coverage', 'id', 'lastUploadAt', 'name', 'notesCount', 'town']);
  const detail = orgDetailSchema.parse({ ...orgDetail(), sales: { months: [{ netSalesCents: 1 }] } });
  expect(Object.keys(detail).sort()).toEqual(['locations', 'members', 'org', 'recent']);
  // Audit details are scalars only (spec 9.1).
  expect(auditEventSchema.safeParse(auditEvent('e1', { details: { nested: { a: 1 } } as never })).success).toBe(false);
  expect(person(EMAIL, 'staff').kind).toBe('staff');
});
