import { researchedEventSchema } from '../../src/portal/analytics/api';
import type { LastChatStore } from '../../src/chat/lastChat';
import { handOffAsk, takeAsk } from '../../src/portal/research/ask';
import { ApiError } from '../../src/api/client';
import { foundSaveCopy } from '../../src/portal/calendar/FoundEditForm';
import { FOUND_NOTICES } from '../../src/portal/research/copy';
import { checkFound, draftOfFound, MAX_FOUND_TEXT } from '../../src/portal/research/edit';
import { bannerShows, markSeen, readSeen, researchSeenKey, runMark } from '../../src/portal/research/seen';
import { foundEvent } from './calendar/fakes';

// D66 task 7.2's pure parts: the edit sheet's draft and check, Ask TownwiseAI's handover, and which run the banner was
// seen for. Made-up titles only.

const EVENT = researchedEventSchema.parse(foundEvent({ start: '2026-12-01', end: '2026-12-14', weekdays: [4] }));

test('the draft starts from the shown values; a time and a place left empty are sent as null', () => {
  const draft = draftOfFound({ ...EVENT, where: null, startTime: null });
  expect(draft).toEqual({ title: 'Trivia night', start: '2026-12-01', end: '2026-12-14', startTime: '', where: '' });
  expect(checkFound({ ...draft, title: ' Quiz night ' }, EVENT)).toEqual({
    messages: {},
    fields: { title: 'Quiz night', start: '2026-12-01', end: '2026-12-14', weekdays: [4], startTime: null, where: null },
  });
});

test('moved dates keep the weekdays that still fall in the new span, and none left reads as every day', () => {
  // Dec 1, 2026 is a Tuesday; the event is on Thursdays.
  expect(checkFound({ ...draftOfFound(EVENT), end: '2026-12-31' }, EVENT).fields?.weekdays).toEqual([4]);
  expect(checkFound({ ...draftOfFound(EVENT), start: '2026-12-03', end: '2026-12-03' }, EVENT).fields?.weekdays).toEqual([4]);
  expect(checkFound({ ...draftOfFound(EVENT), end: '2026-12-02' }, EVENT).fields?.weekdays).toBeNull();
  const twice = { ...EVENT, weekdays: [2, 4] };
  expect(checkFound({ ...draftOfFound(twice), end: '2026-12-02' }, twice).fields?.weekdays).toEqual([2]);
  expect(checkFound({ ...draftOfFound(EVENT), title: 'Quiz' }, { ...EVENT, weekdays: null }).fields?.weekdays).toBeNull();
});

test('the check refuses an empty title, a date that isn’t one, an end before the start and a time that isn’t HH:MM', () => {
  const draft = draftOfFound(EVENT);
  expect(checkFound({ ...draft, title: ' ', start: '2026-02-30', startTime: '25:00' }, EVENT)).toEqual({
    messages: { title: 'Enter a title.', start: 'Enter a date as YYYY-MM-DD.', startTime: 'Enter a time as HH:MM, or leave it empty.' }, fields: null,
  });
  expect(checkFound({ ...draft, end: '2026-11-30' }, EVENT).messages).toEqual({ end: 'The end can’t be before the start.' });
});

test('the sheet takes a title or place as long as the API does, and words each refusal by its field', () => {
  expect(MAX_FOUND_TEXT).toBe(120);
  const refused = (code: string) => new ApiError('http', 'The request was refused.', { status: 400, code });
  expect(foundSaveCopy(refused('bad_title'))).toBe(FOUND_NOTICES.badTitle);
  expect(foundSaveCopy(refused('bad_where'))).toBe(FOUND_NOTICES.badWhere);
  expect(foundSaveCopy(refused('bad_dates'))).toBe(FOUND_NOTICES.badDates);
  expect(foundSaveCopy(refused('invalid_request'))).toBe(FOUND_NOTICES.invalid);
});

test('Ask TownwiseAI’s draft is taken once, and only for its location', () => {
  handOffAsk('l1', 'Is Trivia night on Thu, Dec 3 right?');
  expect(takeAsk('l2')).toBeNull();
  handOffAsk('l1', 'Is Trivia night on Thu, Dec 3 right?');
  expect(takeAsk('l1')).toBe('Is Trivia night on Thu, Dec 3 right?');
  expect(takeAsk('l1')).toBeNull();
});

test('the banner shows for a run a person started until that run is seen; a weekly run never', () => {
  const run = { trigger: 'press' as const, id: 'run-1' };
  expect(bannerShows(run, null)).toBe(true);
  expect(bannerShows(run, runMark(run))).toBe(false);
  // The next run a person starts shows again.
  expect(bannerShows({ ...run, id: 'run-2' }, runMark(run))).toBe(true);
  expect(bannerShows({ ...run, trigger: 'weekly' }, null)).toBe(false);
  expect(bannerShows({ trigger: 'early', id: 'run-3' }, null)).toBe(true);
  expect(bannerShows(null, null)).toBe(false);
});

test('a run is marked by its id from queued to finished, so a mark made while it was queued is not another run’s (UI review)', () => {
  // The old mark was `startedAt ?? 'queued'`: two queued runs read the same.
  expect(runMark({ id: 'run-1' })).not.toBe(runMark({ id: 'run-2' }));
  expect(runMark({ id: 'run-1' })).toBe('run-1');
});

test('the seen run is kept per person and location under a key a secure store takes, and a failing store reads as nothing seen', async () => {
  const kept = new Map<string, string>();
  const store: LastChatStore = {
    read: (key) => Promise.resolve(kept.get(key) ?? null),
    write: (key, value) => { kept.set(key, value); return Promise.resolve(); },
    remove: (key) => { kept.delete(key); return Promise.resolve(); },
  };
  expect(researchSeenKey('u:1', 'l1')).toMatch(/^[A-Za-z0-9._-]+$/);
  await markSeen(store, 'u1', 'l1', { id: 'run-1' });
  expect(await readSeen(store, 'u1', 'l1')).toBe('run-1');
  expect(await readSeen(store, 'u1', 'l2')).toBeNull();
  const broken: LastChatStore = { read: () => Promise.reject(new Error('no')), write: () => Promise.reject(new Error('no')), remove: () => Promise.resolve() };
  expect(await readSeen(broken, 'u1', 'l1')).toBeNull();
  await expect(markSeen(broken, 'u1', 'l1', { id: 'run-1' })).resolves.toBeUndefined();
});
