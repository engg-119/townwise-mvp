import { applyCorrection, correctionOf, type CorrectionCard } from '../../src/chat/corrections';
import { addDays } from '../../src/portal/locations/dates';
import { ACCESS, fakePortalApi, meOf, refusal, writes } from '../helpers/portal';
import { withRoutes } from '../portal/team/fixtures';

// D66 (town-research-agent design decision 12, task 7.4): the correction card read from a correct_calendar_event tool
// part (api/src/chat/tools/correct-calendar-event.ts resultView: `{ applied, code, eventId, changeId, proposed }`), and
// Apply on a proposed one: the person's own PATCH on the head of a fresh read. Made-up titles and places only.

const HEX = 'a'.repeat(24);
const EVENT_ID = `l-${HEX}`;
const BASE = '/api/org/locations/l1';
const TODAY = '2026-11-19';
const CALENDAR = `${BASE}/calendar?from=${addDays(TODAY, -365)}&to=${addDays(TODAY, 395)}`;

function step(state: 'running' | 'done' | 'error', result: Record<string, unknown> | null, change = 'edit') {
  return { id: 'toolu_fix', name: 'correct_calendar_event', state, input: { eventId: EVENT_ID, change }, result };
}

function found(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID, head: 'r1', title: 'Trivia night', start: '2026-12-03', end: '2026-12-03', weekdays: null, startTime: '19:00',
    kind: 'event', category: 'dining', status: 'scheduled', origin: 'neighborhood', confidence: 'medium', where: 'Example Hall',
    who: null, competitor: null, sources: [], lastSeenAt: '2026-11-18T12:00:00.000Z', edited: false, hidden: false, ...fields,
  };
}

function calendarBody(foundEvents: unknown): Record<string, unknown> {
  return { town: { name: 'Hanover', state: 'NH', townId: 'hanover-nh' }, researched: true, covers: null, events: [], found: foundEvents };
}

const RESEARCH = { on: true, available: true, town: null, location: null, next: null, gaps: [], entities: [], hidden: [] as unknown[] };

function proposed(change: 'edit' | 'hide' | 'restore', fields: Record<string, unknown> | null): Extract<CorrectionCard, { kind: 'proposed' }> {
  const card = correctionOf(step('done', {
    applied: false, code: 'needs_tap', eventId: EVENT_ID, changeId: null, proposed: { change, fields },
  }, change));
  if (card?.kind !== 'proposed') throw new Error('not a proposal');
  return card;
}

function api() {
  const fake = fakePortalApi({ me: meOf(ACCESS.member) });
  return { fake, routes: withRoutes(fake) };
}

describe('correctionOf', () => {
  test('a correction made is its card, with the change from its input and the change’s id for Undo', () => {
    expect(correctionOf(step('done', { applied: true, code: null, eventId: EVENT_ID, changeId: 'c1', proposed: null }, 'hide')))
      .toEqual({ id: 'toolu_fix', eventId: EVENT_ID, kind: 'applied', change: 'hide', changeId: 'c1' });
  });

  test('a proposal is its card with only the fields it changes, a null place kept as a change', () => {
    expect(proposed('edit', { start: '2026-12-10', end: '2026-12-10', where: null, extra: 'x' })).toEqual({
      id: 'toolu_fix', eventId: EVENT_ID, kind: 'proposed', change: 'edit', fields: { start: '2026-12-10', end: '2026-12-10', where: null },
    });
    expect(proposed('hide', null).fields).toBeNull();
  });

  test('a call that changed nothing, is still running, failed, or is another tool, stays a row', () => {
    expect(correctionOf(step('done', { applied: false, code: 'not_researched', eventId: EVENT_ID, changeId: null, proposed: null }))).toBeNull();
    expect(correctionOf(step('running', null))).toBeNull();
    expect(correctionOf(step('error', null))).toBeNull();
    expect(correctionOf({ ...step('done', { applied: true, eventId: EVENT_ID, changeId: 'c1' }), name: 'get_day' })).toBeNull();
    // A made correction whose input this client can't read, or a bad proposed date, is a row rather than a wrong card.
    expect(correctionOf({ ...step('done', { applied: true, eventId: EVENT_ID, changeId: 'c1' }), input: null })).toBeNull();
    expect(correctionOf(step('done', { applied: false, code: 'needs_tap', eventId: EVENT_ID, proposed: { change: 'edit', fields: { start: 'Dec 10' } } }))).toBeNull();
  });
});

describe('Apply (the person’s own edit on a fresh head)', () => {
  test('an edit sends only the proposed fields, on the head the calendar reads now', async () => {
    const { fake, routes } = api();
    routes.gets[CALENDAR] = () => calendarBody([found({ head: 'r4' })]);
    fake.answers[`${BASE}/research/events/${EVENT_ID}`] = () => ({ event: found({ head: 'r5', startTime: '20:00', edited: true }) });
    expect(await applyCorrection(fake, 'l1', proposed('edit', { startTime: '20:00' }), TODAY)).toBe('applied');
    expect(writes(fake)).toEqual([{ method: 'PATCH', path: `${BASE}/research/events/${EVENT_ID}`, body: { op: 'edit', fields: { startTime: '20:00' }, basedOn: 'r4' } }]);
  });

  test('a restore of a hidden event takes its head from the Town tab’s hidden list', async () => {
    const { fake, routes } = api();
    routes.gets[CALENDAR] = () => calendarBody([]);
    routes.gets[`${BASE}/research`] = () => ({ ...RESEARCH, hidden: [{ id: EVENT_ID, title: 'Trivia night', start: '2026-12-03', end: '2026-12-03', head: 'r7' }] });
    fake.answers[`${BASE}/research/events/${EVENT_ID}`] = () => ({ event: found({ head: 'r8' }) });
    expect(await applyCorrection(fake, 'l1', proposed('restore', null), TODAY)).toBe('applied');
    expect(writes(fake).map((call) => call.body)).toEqual([{ op: 'restore', basedOn: 'r7' }]);
  });

  test('a change the event already shows sends nothing: a second tap, or a hide of an event already hidden', async () => {
    const { fake, routes } = api();
    routes.gets[CALENDAR] = () => calendarBody([found({ startTime: '20:00', edited: true })]);
    expect(await applyCorrection(fake, 'l1', proposed('edit', { startTime: '20:00' }), TODAY)).toBe('already');
    routes.gets[CALENDAR] = () => calendarBody([]);
    routes.gets[`${BASE}/research`] = () => ({ ...RESEARCH, hidden: [{ id: EVENT_ID, title: 'Trivia night', start: '2026-12-03', end: '2026-12-03', head: 'r7' }] });
    expect(await applyCorrection(fake, 'l1', proposed('hide', null), TODAY)).toBe('already');
    expect(writes(fake)).toEqual([]);
  });

  test('gone when the location can’t see the event any more; changed_since when someone wins the race', async () => {
    const { fake, routes } = api();
    routes.gets[CALENDAR] = () => calendarBody([]);
    routes.gets[`${BASE}/research`] = () => RESEARCH;
    expect(await applyCorrection(fake, 'l1', proposed('hide', null), TODAY)).toBe('gone');
    routes.gets[CALENDAR] = () => calendarBody([found()]);
    fake.answers[`${BASE}/research/events/${EVENT_ID}`] = () => refusal(409, 'changed_since');
    expect(await applyCorrection(fake, 'l1', proposed('hide', null), TODAY)).toBe('changed_since');
  });

  test('a failed found read, and every other refusal, throws for the card to word', async () => {
    const { fake, routes } = api();
    routes.gets[CALENDAR] = () => calendarBody(null);
    await expect(applyCorrection(fake, 'l1', proposed('hide', null), TODAY)).rejects.toThrow('found_unavailable');
    routes.gets[CALENDAR] = () => calendarBody([found()]);
    const error = refusal(409, 'too_many_edits');
    fake.answers[`${BASE}/research/events/${EVENT_ID}`] = () => error;
    await expect(applyCorrection(fake, 'l1', proposed('hide', null), TODAY)).rejects.toBe(error);
  });
});
