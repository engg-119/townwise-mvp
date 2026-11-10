// The forecast lab's callback while the lab is off (no TOWNWISE_LAB_RUNNER, so main.ts builds no lab caller): /lab is
// still mounted, and answers 404 to everything, even the lab identity's own token for a live calibration.
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addLocation, createOrg } from './helpers/fixtures.ts';
import { jobCall, labFailure } from './helpers/lab.ts';
import { logLines, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });

describe('the lab callback while the lab is off', () => {
  it('answers 404 to the input and the result, with or without the lab identity’s token, and reads nothing', async () => {
    const orgId = await createOrg(server, { name: 'Closed Kitchen' });
    const locationId = await addLocation(server, { orgId, name: 'Main Room' });
    const id = new Types.ObjectId();
    // A live calibration left from when the lab was on.
    await server.connection.collection('tw_calibrations').insertOne({
      _id: id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId),
      requestedBy: { userId: null, role: 'superadmin', via: 'console' }, regimeStart: null, status: 'running', championRunId: null,
      dataThrough: null, inputSha256: null, imageDigest: null, codeVersion: null, runId: null, scorecardJson: null, gate: null,
      failure: null, chargedMicroUsd: 0, requestedAt: server.clock.now(), startedAt: server.clock.now(), finishedAt: null,
      liveLocation: new Types.ObjectId(locationId), tokenExpiresAt: new Date(server.clock.now().getTime() + 60_000),
    });
    const before = JSON.stringify(await server.connection.collection('tw_calibrations').findOne({ _id: id }));
    server.logs.length = 0;
    server.commands.length = 0;
    const job = { calibrationId: id.toHexString() };
    const statuses = [
      (await jobCall(server, job, 'input')).status,
      (await jobCall(server, job, 'result', labFailure(job, 'internal'), { resultToken: 'A'.repeat(43) })).status,
      (await jobCall(server, job, 'input', undefined, { authorization: null })).status,
    ];
    expect(statuses).toEqual([404, 404, 404]);
    // Refused before any lookup, and with nothing to log about a caller.
    expect(server.commands.filter((name) => name === 'find')).toEqual([]);
    expect(logLines(server).filter((line) => String(line.msg).startsWith('townwise.lab_callback'))).toEqual([]);
    expect(JSON.stringify(await server.connection.collection('tw_calibrations').findOne({ _id: id }))).toBe(before);
  });
});
