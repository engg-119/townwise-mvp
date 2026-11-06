// Stored-files helpers: the chunked upload sequence over HTTP (with exact Content-Length, which fetch cannot set),
// a held-open chunk for back-pressure tests, and read files seeded straight into tw_files and the memory blobs.
import { request, type ClientRequest, type IncomingMessage } from 'node:http';

import { Types } from 'mongoose';

import type { OrgScope } from '../../src/access/policy.ts';
import type { FileView } from '../../src/handlers/files.ts';
import { cleanBlobName, rawBlobName } from '../../src/files/blobs.ts';
import type { MemoryFileBlobs } from '../../src/files/memory-blobs.ts';
import { call, type TestSession, type TownwiseTestServer } from './server.ts';

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed view of the parsed body, as Response.json gives
  json<T = Record<string, unknown>>(): T;
}

function collect(res: IncomingMessage): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    res.on('data', (part: Buffer) => parts.push(part));
    res.on('error', reject);
    res.on('end', () => {
      const body = Buffer.concat(parts);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- as above
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body.toString('utf8')) as T });
    });
  });
}

/**
 * A PUT whose body the test writes itself: `contentLength` is sent as declared, whatever is written. `response`
 * settles when the server answers (or rejects when the socket closes first).
 */
export function openPut(server: Pick<TownwiseTestServer, 'url'>, path: string, session: TestSession, contentLength: number | null): {
  req: ClientRequest; response: Promise<RawResponse>;
} {
  const url = new URL(path, server.url);
  const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/octet-stream' };
  headers[contentLength === null ? 'transfer-encoding' : 'content-length'] = contentLength === null ? 'chunked' : String(contentLength);
  const req = request(url, { method: 'PUT', headers });
  const response = new Promise<RawResponse>((resolve, reject) => {
    req.on('response', (res) => { collect(res).then(resolve, reject); });
    req.on('error', reject);
  });
  return { req, response };
}

export function putChunk(
  server: Pick<TownwiseTestServer, 'url'>, path: string, session: TestSession, body: Buffer, contentLength: number | null = body.length,
): Promise<RawResponse> {
  const { req, response } = openPut(server, path, session, contentLength);
  req.end(body);
  return response;
}

export function filesPath(locationId: string, rest = ''): string {
  return `/api/org/locations/${locationId}/files${rest}`;
}

export interface Created { file: FileView; import: { id: string; status: string }; limits: Record<string, number> }

/** Create, every chunk in order, complete. Resolves the complete response's body (or the first refusal). */
export async function uploadFile(
  server: TownwiseTestServer, locationId: string, session: TestSession, name: string, bytes: Buffer,
): Promise<{ status: number; body: Record<string, unknown> & { file?: FileView } }> {
  const created = await call(server, filesPath(locationId), { session, json: { name, sizeBytes: bytes.length, purpose: 'history' } });
  if (created.status !== 201) return { status: created.status, body: await created.json() as Record<string, unknown> };
  const { file, limits } = await created.json() as Created;
  const chunkSize = limits.chunkSize ?? 0;
  for (let index = 0; index * chunkSize < bytes.length; index += 1) {
    const sent = await putChunk(server, filesPath(locationId, `/${file.id}/chunks/${String(index)}`), session, bytes.subarray(index * chunkSize, (index + 1) * chunkSize));
    if (sent.status !== 200) return { status: sent.status, body: sent.json() };
  }
  const done = await call(server, filesPath(locationId, `/${file.id}/complete`), { session, json: {} });
  return { status: done.status, body: await done.json() as Record<string, unknown> & { file?: FileView } };
}

/** A file already read (as the worker leaves one): its original and cleaned copy in the memory blobs. */
export async function seedReadFile(
  server: Pick<TownwiseTestServer, 'connection' | 'clock'>,
  blobs: MemoryFileBlobs,
  opts: {
    orgId: string; locationId: string; uploadedBy: string; name: string; raw: Buffer; clean: string;
    importId?: string; uploaderRole?: 'org_admin' | 'member';
  },
): Promise<string> {
  const _id = new Types.ObjectId();
  const importId = opts.importId === undefined ? new Types.ObjectId() : new Types.ObjectId(opts.importId);
  if (opts.importId === undefined) {
    await server.connection.collection('tw_imports').insertOne({
      _id: importId, orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), createdBy: opts.uploadedBy,
      createdAt: server.clock.now(), lastDropAt: server.clock.now(), status: 'done', startedAt: server.clock.now(),
      finishedAt: server.clock.now(), question: null, appliedVersion: 1, drops: 1, lease: null, claimedAt: null, bytesRead: 0, msRead: 0,
    });
  }
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), importId, purpose: 'history',
    uploadedBy: opts.uploadedBy, uploaderRole: opts.uploaderRole ?? 'member', uploadedAt: server.clock.now(), name: opts.name,
    kind: 'text', sizeBytes: opts.raw.length, fingerprint: `${'0'.repeat(63)}1`, upload: null, status: 'read', outcome: null,
    progress: null, readStartedAt: server.clock.now(), readMs: 10, answers: {}, uploadId: new Types.ObjectId(),
    result: {
      dayCount: 1, firstDate: '2026-05-01', lastDate: '2026-05-01', guestsDayCount: 1, netSalesDayCount: 1, inserted: 1,
      replaced: 0, kept: 0, closedDates: [], missingDays: 0, uploadId: new Types.ObjectId().toHexString(),
    },
    report: { rows: 1, days: 1 }, cleanBytes: Buffer.byteLength(opts.clean), rawDeletedAt: null, attempts: 1,
  });
  const scope = { orgId: opts.orgId } as unknown as OrgScope;
  const ref = { locationId: opts.locationId, fileId: _id.toHexString() };
  blobs.raw.set(rawBlobName(scope, ref), opts.raw);
  blobs.clean.set(cleanBlobName(scope, ref), Buffer.from(opts.clean, 'utf8'));
  return _id.toHexString();
}
