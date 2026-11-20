// Calendar files attached to a TownwiseAI message (spec D63; docs/portal/tuning-chat.md section 3) against a scripted
// model (helpers/chat-model.ts) and memory blobs, through the real upload route, whose complete imports a calendar file
// (D60): an .ics file is sent as its text and listed as a calendar file, and the turn tells the model what importing
// each did (added within the last 30 minutes with its label, event count and page, whichever upload of the file made it;
// already a calendar for an older one; refused with Try again on the file's page; or, for a file kept before calendar
// import, how to add it, which works), in that turn's request only. The stored conversation and
// the view hold no label, and no log line or audit event holds a title, a label or a file name. Synthetic files only.
import { randomUUID } from 'node:crypto';

import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JUST_ADDED_MS } from '../src/files/calendar-import.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import { MAX_CALENDARS } from '../src/stores/owner-calendars.ts';
import { message, messagesOf, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { uploadFile } from './helpers/files.ts';
import { call, logLines, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const TITLE = 'Sentinel-title rehearsal dinner';
const NAME = 'Sentinel-name bookings';

function ics(...uids: string[]): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN',
    ...uids.flatMap((uid, index) => [
      'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${TITLE}`, `DTSTART:202606${String(10 + index)}T180000`, `DTEND:202606${String(10 + index)}T210000`, 'END:VEVENT',
    ]),
    'END:VCALENDAR', '',
  ].join('\r\n');
}

const blobs = createMemoryFileBlobs();
let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let member: TestSession;
let locationId: string;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model, files: blobs });
  orgId = await createOrg(server, { name: 'Calendar Chat Tavern' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email, role: 'member' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  model.calls.length = 0;
  locationId = await addLocation(server, { orgId, name: `Taproom ${randomUUID().slice(0, 8)}` });
});
afterEach(() => {
  expect(model.remaining()).toBe(0);
});

/** Uploads a reference file through the route, which imports a calendar file. Resolves its `f_` ref. */
async function keep(name: string, body: string): Promise<string> {
  const done = await uploadFile(server, locationId, member, name, Buffer.from(body, 'utf8'), { purpose: 'reference' });
  expect(done.status).toBe(200);
  return `f_${done.body.file?.id ?? ''}`;
}

async function calendarIdOf(ref: string): Promise<string> {
  const source = await server.connection.collection('tw_calendar_sources').findOne({ fromFileId: new Types.ObjectId(ref.slice(2)) });
  return String(source?._id);
}

/** One turn the model answers. Resolves the conversation's id. */
async function send(content: string, attachments: string[]): Promise<string> {
  model.script({ kind: 'message', message: message([text('Done.')]) });
  const res = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: member, json: { content, attachments } });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('event: done');
  const conversation = /event: conversation\ndata: (.*)\n/.exec(body)?.[1] ?? '{}';
  return (JSON.parse(conversation) as { id: string }).id;
}

function blocksOf(param: BetaMessageParam | undefined): BetaContentBlockParam[] {
  return param === undefined || param.role === 'system' || typeof param.content === 'string' ? [] : param.content;
}

/** The person's message in the last request: its calendar_imports lines, its documents' text and its attachments lines. */
function sent(): { imports: string[]; documents: string[]; attachments: string[] } {
  const blocks = blocksOf(messagesOf(model.calls.at(-1)).at(-1));
  const textOf = (open: string): string[] => {
    const block = blocks.find((b) => b.type === 'text' && b.text.startsWith(open));
    return block?.type === 'text' ? block.text.split('\n').slice(2, -1) : [];
  };
  const documents = blocks.flatMap((b) => (b.type === 'document' && b.source.type === 'text' ? [b.source.data] : []));
  return { imports: textOf('<calendar_imports>'), documents, attachments: textOf('<attachments>') };
}

function noNamesAnywhere(): void {
  const text = JSON.stringify(logLines(server));
  for (const secret of [TITLE, NAME]) expect(text).not.toContain(secret);
}

describe('calendar files attached to a message (D63)', () => {
  it('an .ics file the upload just imported: read as its text, and the turn says it was added, with its label, count and page', async () => {
    const ref = await keep(`${NAME}.ics`, ics('a@example.test', 'b@example.test'));
    const calendarId = await calendarIdOf(ref);
    const id = await send('please add these to my calendar', [ref]);
    const { imports, documents, attachments } = sent();
    expect(attachments).toEqual([`- ${ref}: a calendar file`]);
    expect(documents).toEqual([ics('a@example.test', 'b@example.test')]);
    expect(imports).toEqual([
      `- ${ref}: added within the last 30 minutes as the calendar "${NAME}", with 2 events, when the file was added to Your data. Its page: /locations/${locationId}/data/c_${calendarId}`,
    ]);
    // Stored and shown: the ref and kind, never the label or the file's text.
    const stored = await server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
    expect(JSON.stringify(stored?.messages)).not.toContain(NAME);
    expect(JSON.stringify(stored?.messages)).not.toContain(TITLE);
    const res = await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: member });
    const view = await res.json() as ConversationView;
    expect(view.messages[0]?.attachments).toEqual([{ ref, kind: 'calendar', name: `${NAME}.ics`, state: 'on' }]);
    noNamesAnywhere();
    expect(JSON.stringify(await auditEvents(server))).not.toContain(NAME);
  });

  it('a copy Your data refused as a duplicate is attached as the file it copies, already a calendar since that upload', async () => {
    const ref = await keep(`${NAME}.ics`, ics('dup@example.test'));
    const calendarId = await calendarIdOf(ref);
    // Imported a while ago (the clock stays put, so the session does not expire).
    const before = new Date(server.clock.now().getTime() - JUST_ADDED_MS - 60_000);
    await server.connection.collection('tw_calendar_sources').updateOne({ _id: new Types.ObjectId(calendarId) }, { $set: { createdAt: before } });
    const copy = await uploadFile(server, locationId, member, `${NAME} copy.ics`, Buffer.from(ics('dup@example.test'), 'utf8'), { purpose: 'reference' });
    expect(copy).toMatchObject({ status: 409, body: { error: 'file_duplicate', fileId: ref.slice(2) } });
    await send('add this one too', [ref]);
    expect(sent().imports).toEqual([
      `- ${ref}: already one of the location's calendars, "${NAME}", with 1 event, added on 2026-06-01. Its page: /locations/${locationId}/data/c_${calendarId}`,
    ]);
    // Still one calendar from the file.
    expect(await server.connection.collection('tw_calendar_sources').countDocuments({ fromFileId: new Types.ObjectId(ref.slice(2)) })).toBe(1);
  });

  it('a copy refused as a duplicate within 30 minutes of the upload that made the calendar never says the message added it', async () => {
    const ref = await keep(`${NAME}.ics`, ics('soon@example.test'));
    const calendarId = await calendarIdOf(ref);
    const copy = await uploadFile(server, locationId, member, `${NAME} copy.ics`, Buffer.from(ics('soon@example.test'), 'utf8'), { purpose: 'reference' });
    expect(copy).toMatchObject({ status: 409, body: { error: 'file_duplicate', fileId: ref.slice(2) } });
    await send('add this one too', [ref]);
    expect(sent().imports).toEqual([
      `- ${ref}: added within the last 30 minutes as the calendar "${NAME}", with 1 event, when the file was added to Your data. Its page: /locations/${locationId}/data/c_${calendarId}`,
    ]);
  });

  it('an .ics file kept before calendar import says how to add it, and doing that adds it', async () => {
    const ref = await keep(`${NAME}.ics`, ics('old@example.test'));
    // As D36 kept it before D60: no calendar from it and no import record.
    await server.connection.collection('tw_calendar_sources').deleteMany({ fromFileId: new Types.ObjectId(ref.slice(2)) });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(ref.slice(2)) }, { $unset: { calendarImport: '' } });
    // Attaching it again in chat attaches the file Your data keeps.
    const copy = await uploadFile(server, locationId, member, `${NAME}.ics`, Buffer.from(ics('old@example.test'), 'utf8'), { purpose: 'reference' });
    expect(copy).toMatchObject({ status: 409, body: { error: 'file_duplicate', fileId: ref.slice(2) } });
    await send('please add these to my calendar', [ref]);
    const { imports, documents } = sent();
    expect(documents).toEqual([ics('old@example.test')]);
    expect(imports).toEqual([
      `- ${ref}: not imported: it was kept in Your data before Townwise imported calendar files. To add it as a calendar, a member can press Import as a calendar on the file's page: /locations/${locationId}/data/${ref}`,
    ]);
    expect(await server.connection.collection('tw_calendar_sources').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(0);
    // What the line says works: deleting the file and adding it again imports it.
    const removed = await call(server, `/api/org/locations/${locationId}/files/${ref.slice(2)}`, { session: member, method: 'DELETE' });
    expect(removed.status).toBe(200);
    const again = await keep(`${NAME}.ics`, ics('old@example.test'));
    expect(await calendarIdOf(again)).not.toBe('undefined');
    noNamesAnywhere();
  });

  it('a sixth calendar refused for the limit offers Try again on the file\'s page; one that is no calendar says so, and is still read', async () => {
    for (let index = 0; index < MAX_CALENDARS; index += 1) {
      const res = await call(server, `/api/org/locations/${locationId}/owner-calendars`, {
        session: member, json: { kind: 'file', label: `Calendar ${String(index)}`, ics: ics(`own-${String(index)}@example.test`) },
      });
      expect(res.status).toBe(201);
    }
    const full = await keep(`${NAME}.ics`, ics('late@example.test'));
    const broken = await keep('broken.ics', 'Sentinel-text not a calendar');
    const notes = await keep('notes.txt', 'Dinner prices for June');
    await send('please add these to my calendar', [full, broken, notes]);
    const { imports, documents, attachments } = sent();
    expect(attachments).toEqual([`- ${full}: a calendar file`, `- ${broken}: a calendar file`, `- ${notes}: a text file`]);
    expect(documents).toHaveLength(3);
    expect(imports).toEqual([
      `- ${full}: not added: the location already had 5 calendars, the most it can have. Once the person removes one, they can press Try again on the file's page: /locations/${locationId}/data/${full}`,
      `- ${broken}: not added: Townwise found no calendar in it.`,
    ]);
    // Nothing was added by the turn.
    expect(await server.connection.collection('tw_calendar_sources').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(MAX_CALENDARS);
    noNamesAnywhere();
  });

  it('a message with no calendar file sends no calendar_imports block', async () => {
    const notes = await keep('notes.txt', 'Dinner prices for June');
    await send('what is in this?', [notes]);
    expect(sent().imports).toEqual([]);
  });
});
