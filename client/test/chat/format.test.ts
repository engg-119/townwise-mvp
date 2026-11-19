import { chatEventOf, loadAgentPanel } from '../../src/chat/api';
import { dayText, formatDate, formatDates, formatMessageTime, guestsText, rangeText, shortDayText, weekdayName, weekdaysText } from '../../src/chat/format';
import { fakeChatApi, PROPOSAL } from '../helpers/chat';

test('a proposal reads in plain words', () => {
  expect(formatDate('2026-03-01')).toBe('March 1, 2026');
  expect(formatDate('not a date')).toBe('not a date');
  expect(formatDates({ startDate: '2026-12-24', endDate: '2026-12-24' })).toBe('December 24, 2026');
  expect(formatDates({ startDate: '2026-12-24', endDate: '2027-01-02' })).toBe('December 24, 2026 to January 2, 2027');
  expect(weekdaysText([1])).toBe('Mondays only');
  expect(weekdaysText([5, 0])).toBe('Sundays and Fridays only');
  expect(weekdaysText([1, 3, 5])).toBe('Mondays, Wednesdays and Fridays only');
  expect(weekdaysText(null)).toBeNull();
  expect(weekdaysText([0, 1, 2, 3, 4, 5, 6])).toBeNull();
  expect(guestsText(12000)).toBe('About 12,000 guests');
  expect(guestsText(null)).toBeNull();
});

test('date ranges are short, with the year once when both ends share it', () => {
  expect(rangeText('2026-10-01', '2026-10-31')).toBe('Oct 1 to Oct 31, 2026');
  expect(rangeText('2025-12-20', '2026-01-03')).toBe('Dec 20, 2025 to Jan 3, 2026');
  expect(rangeText('2026-10-01', '2026-10-01')).toBe('Oct 1, 2026');
  expect(rangeText('soon', 'later')).toBe('soon to later');
  expect(dayText('2026-11-26')).toBe('Thu, Nov 26, 2026');
  expect(weekdayName(1)).toBe('Mondays');
});

test('stream events are read by type; unknown events and data that does not match are dropped', () => {
  expect(chatEventOf({ event: 'text', data: '{"delta":"Hi"}' })).toEqual({ type: 'text', delta: 'Hi' });
  expect(chatEventOf({ event: 'proposal', data: JSON.stringify({ id: 'p1', proposal: { ...PROPOSAL, weekdays: undefined, detail: undefined } }) }))
    .toEqual({ type: 'proposal', id: 'p1', proposal: { ...PROPOSAL, weekdays: null, detail: null } });
  // A proposal without the call's id can't be saved through the proposal route: dropped.
  expect(chatEventOf({ event: 'proposal', data: JSON.stringify({ proposal: PROPOSAL }) })).toBeNull();
  expect(chatEventOf({ event: 'tool', data: '{"id":"t1","name":"list_notes","state":"done","input":null,"result":{"count":3}}' }))
    .toEqual({ type: 'tool', id: 't1', name: 'list_notes', state: 'done', input: null, result: { count: 3 } });
  // Views may be left out on running: they read as null.
  expect(chatEventOf({ event: 'tool', data: '{"id":"t1","name":"list_notes","state":"running"}' }))
    .toEqual({ type: 'tool', id: 't1', name: 'list_notes', state: 'running', input: null, result: null });
  expect(chatEventOf({ event: 'done', data: '{"stopReason":"end_turn","costUsd":0.01}' })).toEqual({ type: 'done', stopReason: 'end_turn', leafId: null, sources: [] });
  expect(chatEventOf({ event: 'tool', data: '{"id":"t1","name":"list_notes","state":"later"}' })).toBeNull();
  expect(chatEventOf({ event: 'text', data: 'not json' })).toBeNull();
  expect(chatEventOf({ event: 'message', data: '{}' })).toBeNull();
});

test('the side panel reads questions in the shape the API documents', async () => {
  // Copied from api/README.md (Tuning chat) and docs/portal/tuning-chat.md section 8, so the two sides can't drift.
  const api = fakeChatApi();
  const weekday = { id: 'weekday_1_2026-01-05_2026-10-26', kind: 'weekday', weekday: 1, from: '2026-01-05', to: '2026-10-26', noSalesCount: 30, weekdayCount: 40 };
  const gap = {
    id: 'gap_2026-03-02_2026-03-04', kind: 'gap', from: '2026-03-02', to: '2026-03-04', dayCount: 3, typicalGuestsLow: 80, typicalGuestsHigh: 120,
  };
  const likely = { id: 'likely_closed_2026-03-14', kind: 'likely_closed', date: '2026-03-14', guests: 1, typicalGuests: 100 };
  api.panel = { questions: [weekday, likely, gap], activity: [] };
  // D46: an older API's weekday question is left out (the sales history suggests a closed weekday as a rule instead).
  expect(await loadAgentPanel(api, 'l1')).toEqual({ questions: [likely, gap], activity: [], suggestions: [], weeklySuggestions: null, ruleSuggestions: [], agentAuto: null, noteSuggestions: [], waiting: 0 });
  // A gap from an API without its usual guests still reads (its card then says only that there are no sales).
  const older = { id: 'gap_2026-03-02_2026-03-04', kind: 'gap', from: '2026-03-02', to: '2026-03-04', dayCount: 3 };
  api.panel = { questions: [older], activity: [] };
  expect(await loadAgentPanel(api, 'l1')).toEqual({ questions: [older], activity: [], suggestions: [], weeklySuggestions: null, ruleSuggestions: [], agentAuto: null, noteSuggestions: [], waiting: 0 });
});

test('a short day drops the year', () => {
  expect(shortDayText('2026-10-19')).toBe('Mon, Oct 19');
  expect(shortDayText('soon')).toBe('soon');
});

test('a message’s time is the clock today, then the day, then the year', () => {
  const now = new Date(2026, 10, 11, 21, 30).getTime();
  expect(formatMessageTime(new Date(2026, 10, 11, 20, 59).getTime(), now)).toBe('8:59 PM');
  expect(formatMessageTime(new Date(2026, 10, 9, 20, 59).getTime(), now)).toBe('Nov 9, 8:59 PM');
  expect(formatMessageTime(new Date(2025, 10, 9, 8, 5).getTime(), now)).toBe('Nov 9, 2025, 8:05 AM');
});
