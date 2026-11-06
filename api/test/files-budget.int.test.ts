// The file reader's AI column step against the database (spec 11A): a confident choice is applied and charged, an
// unsure one becomes the question's suggestion, a spent budget or a failed call asks the person, and the bounds hold.
// The model is a scripted fake; logs carry ids and counts only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ExtractModel, ExtractResult } from '../src/files/extract/model.ts';
import type { RedactedProfile } from '../src/files/extract/profile.ts';
import type { FileView, ImportView } from '../src/handlers/files.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { uploadFile } from './helpers/files.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const SENTINEL = 'Zqxj Party Of Twelve';
const UNCLEAR = `Business Date,Item,Total A,Total B\n2025-01-01,${SENTINEL},41,7391.58\n2025-01-02,${SENTINEL},37,6284.17\n`;

let answers: ExtractResult[] = [];
const asked: RedactedProfile[] = [];
const model: ExtractModel = {
  chooseColumns(profile) {
    asked.push(profile);
    return Promise.resolve(answers.shift() ?? { kind: 'answered', choice: null, costMicroUsd: 0 });
  },
};

let server: TownwiseTestServer;
let orgId: string;
let member: TestSession;

beforeAll(async () => {
  server = await startTownwiseServer({ files: createMemoryFileBlobs(), reader: { extract: model, filesMonthlyBudgetUsd: 5 } });
  orgId = await createOrg(server, { name: 'Budget Kitchen' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  answers = [];
  asked.length = 0;
  await server.redis.flushdb();
  await server.connection.collection('tw_files_usage').deleteMany({});
});

async function readOne(text: string): Promise<{ file: FileView; done: ImportView; locationId: string }> {
  const locationId = await addLocation(server, { orgId, name: `Room ${randomUUID().slice(0, 6)}` });
  const uploaded = await uploadFile(server, locationId, member, 'sales.csv', Buffer.from(text));
  const file = uploaded.body.file;
  if (file === undefined) throw new Error('no file');
  const importId = (uploaded.body.import as { id: string }).id;
  await call(server, `/api/org/locations/${locationId}/imports/${importId}/start`, { session: member, json: {} });
  await server.reader?.settled();
  const res = await call(server, `/api/org/locations/${locationId}/imports/${importId}`, { session: member });
  return { file, done: (await res.json() as { import: ImportView }).import, locationId };
}

function usage(): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_files_usage').findOne({ orgId: new Types.ObjectId(orgId) });
}

describe('the AI column step', () => {
  it('applies a confident choice, charges it to the organization and the file, and reports it as the AI’s', async () => {
    answers = [{ kind: 'answered', choice: { guests: 2, netSales: 3, confidence: 'high' }, costMicroUsd: 40_000 }];
    server.logs.length = 0;
    const { file, done, locationId } = await readOne(UNCLEAR);
    expect(done.files[0]).toMatchObject({ status: 'read', result: { dayCount: 2 } });
    const detail = await (await call(server, `/api/org/locations/${locationId}/files/${file.id}`, { session: member })).json() as { report: Record<string, unknown> };
    expect(detail.report.decidedBy).toMatchObject({ date: 'rules', guests: 'ai', netSales: 'ai' });
    expect(await usage()).toMatchObject({ costMicroUsd: 40_000 });
    expect(await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(file.id) })).toMatchObject({ modelCalls: 1, costMicroUsd: 40_000 });
    expect(asked).toHaveLength(1);
    const logged = server.logs.join('\n');
    expect(logged).toContain('townwise.extract_model_call');
    for (const secret of [SENTINEL, 'Total A', '7391.58']) expect(logged).not.toContain(secret);
  });

  it('suggests an unsure choice in the question it asks', async () => {
    answers = [{ kind: 'answered', choice: { guests: 2, netSales: null, confidence: 'low' }, costMicroUsd: 30_000 }];
    const { done } = await readOne(UNCLEAR);
    expect(done).toMatchObject({ status: 'waiting', question: { kind: 'columns', suggested: 'guests:2,netSales:none' } });
    expect(await usage()).toMatchObject({ costMicroUsd: 30_000 });
  });

  it('asks the person without calling the model once the month’s budget is spent', async () => {
    await server.connection.collection('tw_files_usage').insertOne({
      orgId: new Types.ObjectId(orgId), month: server.clock.now().toISOString().slice(0, 7), costMicroUsd: 5_000_000, updatedAt: server.clock.now(),
    });
    const { done } = await readOne(UNCLEAR);
    expect(done).toMatchObject({ status: 'waiting', question: { kind: 'columns', suggested: null } });
    expect(asked).toHaveLength(0);
  });

  it('asks the person after a failed call, counts the call, and logs its class and status only', async () => {
    answers = [{ kind: 'failed', errType: 'InternalServerError', status: 500 }];
    server.logs.length = 0;
    const { file, done } = await readOne(UNCLEAR);
    expect(done).toMatchObject({ status: 'waiting', question: { kind: 'columns' } });
    expect(await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(file.id) })).toMatchObject({ modelCalls: 1, costMicroUsd: 0 });
    expect(server.logs.join('\n')).toContain('"errType":"InternalServerError"');
  });

  it('never asks the model when the rules find the columns', async () => {
    await readOne('Date,Guests,Net Sales\n2025-01-01,4,40.00\n');
    expect(asked).toHaveLength(0);
  });
});
