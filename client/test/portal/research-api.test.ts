import { ApiError } from '../../src/api/client';
import { calendarSchema, foundSchema } from '../../src/portal/analytics/api';
import {
  fetchCompetition, fetchResearch, runResearch, setResearch, updateResearchedEvent,
} from '../../src/portal/research/api';
import { ACCESS, fakePortalApi, meOf, refusal, writes } from '../helpers/portal';
import { withRoutes } from './team/fixtures';

// D66 (town-research-agent) task 7.1: the calendar's `found`, read item by item, and the research routes' calls
// (design decisions 11 and 13). Made-up titles, places and links only.

const BASE = '/api/org/locations/l1';
const HEX = 'a'.repeat(24);

function found(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `l-${HEX}`, head: 'base', title: 'Trivia night', start: '2026-12-03', end: '2026-12-03', weekdays: null, startTime: '19:00',
    kind: 'event', category: 'dining', status: 'scheduled', origin: 'competitor', confidence: 'medium', where: 'Example Tavern',
    who: null, competitor: { entityId: 'e1', placeId: null }, sources: [{ label: 'example.com', url: 'https://example.com/trivia' }],
    lastSeenAt: '2026-11-18T12:00:00.000Z', edited: false, hidden: false, ...fields,
  };
}

const TOWN = { name: 'Hanover', state: 'NH', townId: 'hanover-nh' };

function calendarBody(extra: Record<string, unknown>): Record<string, unknown> {
  return { town: TOWN, researched: true, covers: null, events: [], ...extra };
}

function api() {
  const fake = fakePortalApi({ me: meOf(ACCESS.member) });
  const routes = withRoutes(fake);
  return { fake, routes };
}

describe('the calendar’s found (spec 10.10, D66)', () => {
  test('an item that fails is dropped and the others kept', () => {
    const bad = found({ id: 'not-an-id' });
    const lowDate = found({ id: `t-${'b'.repeat(24)}`, start: 'Dec 3' });
    const good = found({ id: `t-${'c'.repeat(24)}`, origin: 'town', competitor: null, confidence: 'low' });
    const read = calendarSchema.parse(calendarBody({ found: [bad, found(), lowDate, 'x', good] })).found;
    expect(read?.map((event) => event.id)).toEqual([`l-${HEX}`, `t-${'c'.repeat(24)}`]);
    // `head` is kept, for an edit's basedOn; keys the client doesn't use are stripped.
    expect(read?.[0]?.head).toBe('base');
    expect(read?.[0]).not.toHaveProperty('hidden');
  });

  test('an API without found reads [], and null (the read failed) stays null, read as unavailable', () => {
    expect(calendarSchema.parse(calendarBody({})).found).toEqual([]);
    expect(calendarSchema.parse(calendarBody({ found: null })).found).toBeNull();
    expect(foundSchema.parse({ not: 'a list' })).toEqual([]);
  });

  test('a source that is not https is dropped, javascript: and http: included, and the event keeps its others', () => {
    const event = found({
      sources: [
        { label: 'kept', url: 'https://example.com/a' },
        { label: 'script', url: 'javascript:alert(1)' },
        { label: 'plain', url: 'http://example.com/b' },
        { label: 'spaced', url: ' https://example.com/c' },
        { label: 'relative', url: '/events' },
      ],
    });
    const read = foundSchema.parse([event]);
    expect(read?.[0]?.sources.map((source) => source.label)).toEqual(['kept']);
  });

  test('an event whose start is after its end, or whose weekday is out of range, is dropped', () => {
    expect(foundSchema.parse([found({ start: '2026-12-04', end: '2026-12-03' }), found({ weekdays: [7] })])).toEqual([]);
  });
});

describe('the research routes (design decision 13)', () => {
  const RESEARCH = {
    on: true, available: true,
    town: { status: 'done', finishedAt: '2026-11-17T10:00:00.000Z', threads: [{ thread: 'sports', status: 'recorded', code: null }, 'bad'], counts: { found: 9, added: 3, updated: 1, dropped: 2 } },
    location: { id: 'run-1', status: 'running', finishedAt: null, threads: [], counts: { found: 0, added: 0, updated: 0, dropped: 0 }, trigger: 'press', startedAt: '2026-11-19T14:00:00.000Z' },
    next: '2026-11-23', pressAt: '2026-11-19T20:00:00.000Z', gaps: ['budget', 'later_gap'], entities: [{ id: 'e1', type: 'venue', name: 'Example Hall', events: 2 }],
    hidden: [{ id: `l-${HEX}`, title: 'Trivia night', start: '2026-12-03', end: '2026-12-03', head: 'r1' }],
  };

  test('GET .../research parses the status, leaving out a thread it can’t read and a gap it has no words for', async () => {
    const { fake, routes } = api();
    routes.gets[`${BASE}/research`] = () => RESEARCH;
    const read = await fetchResearch(fake, 'l1');
    expect(read.town?.threads).toEqual([{ thread: 'sports', status: 'recorded', code: null }]);
    expect(read.location?.trigger).toBe('press');
    expect(read.location?.id).toBe('run-1');
    expect(read.pressAt).toBe('2026-11-19T20:00:00.000Z');
    // An answer without pressAt reads as Research now open.
    routes.gets[`${BASE}/research`] = () => ({ ...RESEARCH, pressAt: undefined });
    expect((await fetchResearch(fake, 'l1')).pressAt).toBeNull();
    expect(read.gaps).toEqual(['budget']);
    expect(read.hidden[0]?.head).toBe('r1');
  });

  test('a run with a status this client doesn’t know reads as none, and the rest of the read stays', async () => {
    const { fake, routes } = api();
    routes.gets[`${BASE}/research`] = () => ({ ...RESEARCH, location: { ...RESEARCH.location, status: 'later_status' } });
    const read = await fetchResearch(fake, 'l1');
    expect(read.location).toBeNull();
    expect(read.town?.status).toBe('done');
  });

  test('an edit sends op, fields and basedOn to the event’s path; the saved answer’s event is read', async () => {
    const { fake } = api();
    fake.answers[`${BASE}/research/events/l-${HEX}`] = () => ({ event: found({ head: 'r2', title: 'Quiz night', edited: true }) });
    const fields = { title: 'Quiz night', start: '2026-12-03', end: '2026-12-03', weekdays: null, startTime: '19:00', where: 'Example Tavern' };
    const result = await updateResearchedEvent(fake, 'l1', `l-${HEX}`, { op: 'edit', fields, basedOn: 'base' });
    expect(writes(fake)).toEqual([{ method: 'PATCH', path: `${BASE}/research/events/l-${HEX}`, body: { op: 'edit', fields, basedOn: 'base' } }]);
    expect(result.status === 'saved' ? result.event?.head : null).toBe('r2');
  });

  test('409 changed_since answers the current view, with its new head, rather than throwing', async () => {
    const { fake } = api();
    fake.answers[`${BASE}/research/events/l-${HEX}`] = () => new ApiError('http', 'The request was refused.', {
      status: 409, code: 'changed_since', detail: { event: found({ head: 'r9', title: 'Pub quiz', edited: true }) },
    });
    const result = await updateResearchedEvent(fake, 'l1', `l-${HEX}`, { op: 'hide', basedOn: 'base' });
    expect(result.status).toBe('changed_since');
    expect(result.status === 'changed_since' ? [result.current?.head, result.current?.title] : null).toEqual(['r9', 'Pub quiz']);
    // Without a view in the body it still answers changed_since, and the page reads the calendar again.
    fake.answers[`${BASE}/research/events/l-${HEX}`] = () => refusal(409, 'changed_since');
    expect(await updateResearchedEvent(fake, 'l1', `l-${HEX}`, { op: 'restore', basedOn: 'r1' })).toEqual({ status: 'changed_since', current: null, hidden: false });
  });

  test('every other refusal throws: too_many_edits, a 404 and view-as', async () => {
    const { fake } = api();
    for (const error of [refusal(409, 'too_many_edits'), refusal(404, 'not_found'), refusal(403, 'view_as_read_only')]) {
      fake.answers[`${BASE}/research/events/l-${HEX}`] = () => error;
      await expect(updateResearchedEvent(fake, 'l1', `l-${HEX}`, { op: 'hide', basedOn: 'base' })).rejects.toBe(error);
    }
  });

  test('Research now posts to the run path; its refusals throw for the page to word', async () => {
    const { fake } = api();
    fake.answers[`${BASE}/research/run`] = () => ({ run: {} });
    await runResearch(fake, 'l1');
    expect(writes(fake)).toEqual([{ method: 'POST', path: `${BASE}/research/run`, body: {} }]);
    fake.answers[`${BASE}/research/run`] = () => refusal(409, 'research_running');
    await expect(runResearch(fake, 'l1')).rejects.toMatchObject({ status: 409, code: 'research_running' });
  });

  test('the switch sends on, and orgId only when staff open the organization as admin', async () => {
    const { fake } = api();
    fake.answers['/api/org/research'] = (body) => ({ research: { on: (body as { on: boolean }).on } });
    expect(await setResearch(fake, false, null)).toBe(false);
    expect(await setResearch(fake, false, 'o1')).toBe(false);
    expect(writes(fake).map((call) => call.body)).toEqual([{ on: false }, { on: false, orgId: 'o1' }]);
  });

  test('GET .../competition reads the lettered competitors and the web list item by item', async () => {
    const { fake, routes } = api();
    routes.gets[`${BASE}/competition?theme=light`] = () => ({
      gap: null, map: null,
      competitors: [
        { letter: 'A', placeId: 'p1', name: 'Example Tavern', type: 'bar', distanceM: 220, x: 0.4, y: 0.6, events: [found(), found({ id: 'bad' })] },
        { letter: 'B' },
      ],
      web: [{ name: 'Example Cafe', events: [found({ id: `l-${'d'.repeat(24)}` })] }],
    });
    const read = await fetchCompetition(fake, 'l1', 'light');
    expect(read.competitors.map((each) => [each.letter, each.events.length])).toEqual([['A', 1]]);
    expect(read.web[0]?.events[0]?.id).toBe(`l-${'d'.repeat(24)}`);
  });
});
