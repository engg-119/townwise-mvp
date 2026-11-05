import { chatEventOf } from '../../src/chat/api';
import { formatDate, formatDates, guestsText, toolLabel, weekdaysText } from '../../src/chat/format';
import { PROPOSAL } from '../helpers/chat';

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

test('every tool has a status line, and an unknown one still says something', () => {
  expect(['get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note'].map(toolLabel)).toEqual([
    'Reading the sales summary', 'Reading sales history', 'Reading your notes', 'Reading the town profile', 'Writing a note',
  ]);
  expect(toolLabel('something_new')).toBe('Looking something up');
});

test('stream events are read by type; unknown events and data that does not match are dropped', () => {
  expect(chatEventOf({ event: 'text', data: '{"delta":"Hi"}' })).toEqual({ type: 'text', delta: 'Hi' });
  expect(chatEventOf({ event: 'proposal', data: JSON.stringify({ proposal: { ...PROPOSAL, weekdays: undefined, detail: undefined } }) }))
    .toEqual({ type: 'proposal', proposal: { ...PROPOSAL, weekdays: null, detail: null } });
  expect(chatEventOf({ event: 'done', data: '{"stopReason":"end_turn","costUsd":0.01}' })).toEqual({ type: 'done', stopReason: 'end_turn' });
  expect(chatEventOf({ event: 'tool', data: '{"name":"list_notes","state":"later"}' })).toBeNull();
  expect(chatEventOf({ event: 'text', data: 'not json' })).toBeNull();
  expect(chatEventOf({ event: 'message', data: '{}' })).toBeNull();
});
