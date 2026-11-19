// correct_calendar_event (D66, openspec change town-research-agent, task 6.4, design decision 12): TownwiseAI edits,
// hides or restores an event town research found, at this location only, when a person asks. In a clean turn it is
// applied through agent/apply.ts (`event.correct`) with Undo; in a turn that read the web or a file it only proposes the
// change (`needs_tap`); a curated row is `not_researched`, a bad title `bad_title`, staff and view-as are refused, at
// most 5 run a turn, and another town's or organization's id is not found. The stored conversation keeps the call as the
// existing `tool` part. The model is a scripted fake: no call leaves the test. Every event and name is made up.
import { randomUUID } from 'node:crypto';

import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { correctCalendarEventTool, MAX_CORRECTIONS_PER_TURN } from '../src/chat/tools/correct-calendar-event.ts';
import type { ToolContext } from '../src/chat/tools/registry.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { readResearchedViews } from '../src/research/read.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import type { EventInsertBase } from '../src/stores/research-shared.ts';
import { message, messagesOf, scriptedModel, text, toolUse, webResults, webSearch, type ScriptedModel, type Step } from './helpers/chat-model.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const SENTINEL = 'Wvkx';
const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const RUN = new Types.ObjectId().toHexString();
const FAIR = 'https://www.example.com/trivia/2026';
const TOOL = 'correct_calendar_event';

let server: TownwiseTestServer;
let model: ScriptedModel;
const blobs = createMemoryFileBlobs();

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model, files: blobs, env: { TOWNWISE_CHAT_WEB_SEARCH: 'true' } });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  model.calls.length = 0;
  server.logs.length = 0;
  await server.connection.collection('tw_chat_usage').deleteMany({});
});
afterEach(() => { expect(model.remaining()).toBe(0); });

interface Team { orgId: string; locationId: string; scope: OrgScope; member: TestSession }

async function team(): Promise<Team> {
  const orgId = await createOrg(server, { name: `Correct Cafe ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email, role: 'member' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId), member };
}

function row(over: Partial<EventInsertBase> = {}): EventInsertBase {
  const now = server.clock.now();
  return {
    title: `${SENTINEL} Trivia Night`, titleKey: `${SENTINEL.toLowerCase()} trivia night`, kind: 'event', category: 'dining', start: '2026-06-17',
    end: '2026-06-17', weekdays: null, startTime: '19:00', status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
    sources: [{ label: 'example.com', url: FAIR }], firstRunId: RUN, lastRunId: RUN, firstSeenAt: now, lastSeenAt: now, seenCount: 1, ...over,
  };
}

/** A location row of `t`'s, stamped with its current place and town; its view id. */
async function ownEvent(t: Team, over: Partial<EventInsertBase> = {}): Promise<string> {
  const location = await server.ctx.stores.locations.find(t.scope, t.locationId);
  const inserted = await server.ctx.stores.researchLocations.insertEvent(t.scope, t.locationId, {
    ...row(over), placeId: location?.placeId ?? null, town: 'hanover-nh', origin: 'competitor', competitorEntityId: null, competitorPlaceId: null,
  });
  return `l-${inserted.id}`;
}

async function townEvent(townKey: 'hanover-nh' | 'ithaca-ny', over: Partial<EventInsertBase> = {}): Promise<string> {
  return `t-${(await server.ctx.stores.researchTowns.insertEvent(townKey, row(over))).id}`;
}

interface SseEvent { event: string; data: unknown }

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as unknown }];
  });
}

/** One turn the model answers with `steps`; resolves the conversation's id. */
async function turn(t: Team, steps: Step[], json: Record<string, unknown> = { content: `Fix the ${SENTINEL} trivia night` }, who = t.member): Promise<string> {
  model.script(...steps);
  const res = await call(server, `/api/org/locations/${t.locationId}/chat/turns`, { session: who, json });
  expect(res.status).toBe(200);
  const events = parseSse(await res.text());
  expect(events.at(-1)?.event).toBe('done');
  return (events[0]?.data as { id: string }).id;
}

/** A turn whose model corrects with each input (one call each, in one message), then answers. */
function correcting(...inputs: Record<string, unknown>[]): Step[] {
  return [
    { kind: 'message', message: message(inputs.map((input, i) => toolUse(`c${String(i)}_${randomUUID().slice(0, 6)}`, TOOL, input))) },
    { kind: 'message', message: message([text('Done.')]) },
  ];
}

/** The correction results the model read back on the last request. */
function results(): Record<string, unknown>[] {
  const last = messagesOf(model.calls.at(-1)).at(-1);
  const blocks = last === undefined || typeof last.content === 'string' ? [] : last.content ?? [];
  return blocks.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result')
    .map((block) => JSON.parse(block.content as string) as Record<string, unknown>);
}

async function revisions(t: Team) {
  return server.ctx.stores.researchRevisions.list(t.scope, t.locationId);
}

async function shown(t: Team, eventId: string) {
  const location = await server.ctx.stores.locations.find(t.scope, t.locationId);
  if (location === null) throw new Error('fixture location missing');
  return (await readResearchedViews(server.ctx, t.scope, location, null)).find((view) => view.id === eventId);
}

const why = 'The owner says it moved';

describe('correct_calendar_event in a clean turn', () => {
  it('hides the event at this location with Undo, and the stored conversation keeps it as a tool part', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    const id = await turn(t, correcting({ eventId, change: 'hide', why }));
    const [result] = results();
    expect(result).toMatchObject({ applied: true, code: null, eventId, changeId: expect.any(String) as string, proposed: null });
    const changeId = result?.changeId as string;
    expect(await shown(t, eventId)).toMatchObject({ hidden: true });
    const [revision] = await revisions(t);
    expect(revision).toMatchObject({ eventId, op: 'hide', basedOn: 'base', by: { kind: 'chat', conversationId: id, changeId } });
    expect(await server.connection.collection('tw_agent_changes').findOne({ _id: new Types.ObjectId(changeId) }))
      .toMatchObject({ action: 'event.correct', sourceKind: 'chat', sourceId: id, status: 'applied', onBehalfOf: t.member.userId, why });

    const view = await (await call(server, `/api/org/locations/${t.locationId}/chat/${id}`, { session: t.member })).json() as ConversationView;
    const part = view.messages[1]?.parts.find((each) => each.type === 'tool' && each.name === TOOL);
    expect(part).toEqual({
      type: 'tool', id: expect.any(String) as string, name: TOOL, state: 'done', input: { eventId, change: 'hide' },
      result: { applied: true, code: null, eventId, changeId, proposed: null },
    });

    const panel = await (await call(server, `/api/org/locations/${t.locationId}/agent`, { session: t.member })).json() as { activity: Record<string, unknown>[] };
    expect(panel.activity.find((item) => item.kind === 'agent_change')).toMatchObject({ changeId, action: 'event.correct', undoable: true });
    expect((await call(server, `/api/org/locations/${t.locationId}/agent/changes/${changeId}/undo`, { session: t.member, method: 'POST' })).status).toBe(200);
    expect(await shown(t, eventId)).toMatchObject({ hidden: false });
    expect((await revisions(t)).map((each) => each.op)).toEqual(['hide', 'revert']);
    expect((await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(t.locationId) }))?.refit).toBeUndefined();
    expect(server.logs.join('\n')).not.toContain(SENTINEL);
    expect(server.logs.join('\n')).not.toContain(why);
  });

  it('edits a shared town row for this location only, on the head as read now, with the title and dates checked', async () => {
    const t = await team();
    const other = await team();
    const eventId = await townEvent('hanover-nh');
    await turn(t, correcting({ eventId, change: 'edit', title: `${SENTINEL} Quiz Night`, start: '2026-06-18', end: '2026-06-18', why }));
    expect(results()[0]).toMatchObject({ applied: true, eventId });
    expect(await shown(t, eventId)).toMatchObject({ title: `${SENTINEL} Quiz Night`, start: '2026-06-18', edited: true });
    expect(await shown(other, eventId)).toMatchObject({ title: `${SENTINEL} Trivia Night`, start: '2026-06-17', edited: false });
    // A second correction is appended on the first one's revision.
    const head = (await shown(t, eventId))?.head;
    await turn(t, correcting({ eventId, change: 'edit', startTime: '20:00', why }));
    expect(results()[0]).toMatchObject({ applied: true });
    expect((await revisions(t)).at(-1)).toMatchObject({ basedOn: head, fields: { startTime: '20:00' } });
  });

  it('answers bad_title, bad_dates, not_researched and not_found, and changes nothing', async () => {
    const t = await team();
    const other = await team();
    const eventId = await ownEvent(t);
    const othersEvent = await ownEvent(other);
    const ithaca = await townEvent('ithaca-ny');
    await turn(t, correcting(
      { eventId, change: 'edit', title: 'See https://example.com/trivia', why },
      { eventId, change: 'edit', where: 'Call 603-555-0100', why },
      { eventId, change: 'edit', start: '2026-06-20', end: '2026-06-19', why },
      { eventId: 'hanover-nh-commencement-2026', change: 'hide', why },
      { eventId: ithaca, change: 'hide', why },
    ));
    expect(results().map((result) => result.code)).toEqual(['bad_title', 'bad_title', 'bad_dates', 'not_researched', 'not_found']);
    await turn(t, correcting({ eventId: othersEvent, change: 'hide', why }));
    expect(results()[0]).toMatchObject({ applied: false, code: 'not_found' });
    expect(await revisions(t)).toEqual([]);
    expect(await server.ctx.stores.researchRevisions.list(other.scope, other.locationId)).toEqual([]);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({ orgId: new Types.ObjectId(t.orgId) })).toBe(0);
  });

  it('runs at most 5 a turn: the sixth answers too_many', async () => {
    const t = await team();
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => ownEvent(t, { title: `${SENTINEL} Night ${String(i)}`, titleKey: `night ${String(i)}` })));
    expect(MAX_CORRECTIONS_PER_TURN).toBe(5);
    await turn(t, [
      { kind: 'message', message: message(ids.slice(0, 3).map((eventId, i) => toolUse(`a${String(i)}`, TOOL, { eventId, change: 'hide', why }))) },
      { kind: 'message', message: message(ids.slice(3).map((eventId, i) => toolUse(`b${String(i)}`, TOOL, { eventId, change: 'hide', why }))) },
      { kind: 'message', message: message([text('Done.')]) },
    ]);
    expect(results().map((result) => result.code)).toEqual([null, null, 'too_many']);
    expect(await revisions(t)).toHaveLength(5);
  });

  it('answers too_many_edits once the location holds 1,000 revisions, as the edit route does', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    const at = { orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId) };
    // Another event's chain, 999 deep: the location is one short of the cap.
    await server.connection.collection('tw_research_revisions').insertMany(Array.from({ length: 999 }, (_, i) => ({
      ...at, eventId: `l-${new Types.ObjectId().toHexString()}`, op: 'hide', fields: null, reverts: null,
      basedOn: i === 0 ? 'base' : new Types.ObjectId().toHexString(), by: { kind: 'person', userId: t.member.userId }, createdAt: server.clock.now(),
    })));
    await turn(t, correcting({ eventId, change: 'hide', why }, { eventId, change: 'restore', why }));
    expect(results().map((result) => result.code)).toEqual([null, 'too_many_edits']);
    expect(await server.ctx.stores.researchRevisions.count(t.scope, t.locationId)).toBe(1_000);
    expect(await shown(t, eventId)).toMatchObject({ hidden: true });
    expect(await server.connection.collection('tw_agent_changes').countDocuments({ orgId: at.orgId })).toBe(1);
  });

  it('is not blocked by a calendar read (readNotTyped) nor gated on TownwiseAI working on its own', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    await server.connection.collection('tw_orgs').updateOne(
      { _id: new Types.ObjectId(t.orgId) }, { $set: { agentAuto: { on: false, at: server.clock.now(), by: t.member.userId } } },
    );
    const location = await server.ctx.stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('fixture location missing');
    const tc = {
      ctx: server.ctx, conversationId: new Types.ObjectId().toHexString(), scope: t.scope, location, today: '2026-06-01', timeZone: 'America/New_York',
      role: 'member', actor: { actorUserId: t.member.userId, actorEmail: null, actorRole: 'member', viewAsGrantId: null },
      turn: { readUntrusted: false, readWeb: false, readNotTyped: true, pictureBytes: 0, readResearchedDays: new Set(['2026-06-17']) },
      files: {} as ToolContext['files'],
    } as unknown as ToolContext;
    const input = correctCalendarEventTool.parse({ eventId, change: 'hide', why }, '2026-06-01');
    if (input === null) throw new Error('fixture input refused');
    const run = await correctCalendarEventTool.run(tc, input, 'toolu_not_typed');
    expect(JSON.parse(run.content)).toMatchObject({ applied: true, code: null, eventId });
    expect(await shown(t, eventId)).toMatchObject({ hidden: true });
  });
});

describe('correct_calendar_event after a web or file read', () => {
  it('answers needs_tap with the proposed change after a search, and in a later turn of that conversation; a new conversation applies it', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    const input = { eventId, change: 'edit', start: '2026-06-18', end: '2026-06-18', weekdays: [4, 4], why };
    const proposed = { change: 'edit', fields: { start: '2026-06-18', end: '2026-06-18', weekdays: [4] } };
    const id = await turn(t, [
      { kind: 'message', message: message([webSearch('s1'), webResults('s1', [FAIR]), toolUse('c1', TOOL, input)]) },
      { kind: 'message', message: message([text('Check the card.')]) },
    ]);
    expect(results()[0]).toMatchObject({ applied: false, code: 'needs_tap', eventId, changeId: null, proposed });
    const view = await (await call(server, `/api/org/locations/${t.locationId}/chat/${id}`, { session: t.member })).json() as ConversationView;
    expect(view.messages[1]?.parts.find((each) => each.type === 'tool' && each.name === TOOL)).toMatchObject({
      result: { applied: false, code: 'needs_tap', eventId, changeId: null, proposed },
    });

    await turn(t, correcting(input), { conversationId: id, content: 'Move it to the 18th' });
    expect(results()[0]).toMatchObject({ code: 'needs_tap', proposed });
    expect(await revisions(t)).toEqual([]);
    expect(await server.connection.collection('tw_agent_changes').countDocuments({ orgId: new Types.ObjectId(t.orgId) })).toBe(0);

    await turn(t, correcting(input), { content: 'Move it to the 18th' });
    expect(results()[0]).toMatchObject({ applied: true });
    expect(await shown(t, eventId)).toMatchObject({ start: '2026-06-18', weekdays: [4] });
  });

  it('answers needs_tap in a turn that read a file from Your data', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    const fileId = new Types.ObjectId();
    const bytes = Buffer.from('The trivia night is cancelled.');
    await server.connection.collection('tw_files').insertOne({
      _id: fileId, orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), importId: null, purpose: 'reference',
      uploadedBy: t.member.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'note.txt', kind: 'text', sizeBytes: bytes.length,
      fingerprint: fileId.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference', progress: null, readStartedAt: null,
      readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null, rawDeletedAt: null, attempts: 0,
    });
    await blobs.writeRaw(t.scope, { locationId: t.locationId, fileId: fileId.toHexString() }, bytes, 'text/plain');
    await turn(t, [
      { kind: 'message', message: message([toolUse('r1', 'read_data_item', { ref: `f_${fileId.toHexString()}` })]) },
      ...correcting({ eventId, change: 'hide', why }),
    ]);
    expect(results()[0]).toMatchObject({ applied: false, code: 'needs_tap', proposed: { change: 'hide', fields: null } });
    expect(await revisions(t)).toEqual([]);
  });
});

describe('correct_calendar_event for staff and under view-as', () => {
  it('staff open as admin are refused, and view-as sends no turn', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    const staff = await signInStaff(server);
    try {
      await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
      await turn(t, correcting({ eventId, change: 'hide', why }), undefined, staff);
      expect(results()[0]).toMatchObject({ applied: false, code: 'staff' });
      await server.connection.collection('tw_view_as_grants').deleteMany({});
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.member.userId, orgId: t.orgId });
      const res = await call(server, `/api/org/locations/${t.locationId}/chat/turns`, { session: staff, json: { content: 'Hide it' } });
      expect(res.status).toBe(403);
      expect(await revisions(t)).toEqual([]);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('the tool itself refuses a turn under view-as', async () => {
    const t = await team();
    const eventId = await ownEvent(t);
    const location = await server.ctx.stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('fixture location missing');
    const tc = {
      ctx: server.ctx, conversationId: new Types.ObjectId().toHexString(), scope: t.scope, location, today: '2026-06-01', timeZone: 'America/New_York',
      role: 'member', actor: { actorUserId: t.member.userId, actorEmail: null, actorRole: 'member', viewAsGrantId: new Types.ObjectId().toHexString() },
      turn: { readUntrusted: false, readWeb: false, readNotTyped: false, pictureBytes: 0 }, files: {} as ToolContext['files'],
    } as unknown as ToolContext;
    const input = correctCalendarEventTool.parse({ eventId, change: 'hide', why }, '2026-06-01');
    if (input === null) throw new Error('fixture input refused');
    const run = await correctCalendarEventTool.run(tc, input, 'toolu_view_as');
    expect(JSON.parse(run.content)).toMatchObject({ applied: false, code: 'view_as' });
    expect(await revisions(t)).toEqual([]);
  });
});

describe('correct_calendar_event’s input', () => {
  it('needs a field to edit, takes none to hide or restore, and keeps the why at 200 characters', () => {
    const parse = (raw: unknown) => correctCalendarEventTool.parse(raw, '2026-06-01');
    const eventId = `l-${new Types.ObjectId().toHexString()}`;
    expect(parse({ eventId, change: 'edit', why })).toBeNull();
    expect(parse({ eventId, change: 'hide', title: 'x', why })).toBeNull();
    expect(parse({ eventId, change: 'hide', why: 'x'.repeat(201) })).toBeNull();
    expect(parse({ eventId, change: 'edit', startTime: '7pm', why })).toBeNull();
    expect(parse({ eventId, change: 'restore', why: '  ' })).toEqual({ eventId, change: 'restore', edit: null, why: null });
    expect(parse({ eventId, change: 'edit', where: null, why })).toEqual({ eventId, change: 'edit', edit: { where: null }, why });
  });
});
