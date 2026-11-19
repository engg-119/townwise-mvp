import type { DataCalendar } from '../../../src/portal/data/api';
import { dataViewKey } from '../../../src/portal/data/dataView';
import { byFolder, entriesOf, folderOf, FOLDERS } from '../../../src/portal/data/folders';
import { itemOf } from './fakes';

// Your data's one list (D61, src/portal/data/folders.ts): items and calendars newest first, a calendar held back in
// Newest first until the items reach its time, and the folders in their order with every one present.

function calendarOf(id: string, createdAt: string): DataCalendar {
  return {
    id, locationId: 'l1', label: id, kind: 'file', host: null, eventCount: 1, skippedRepeating: 0, status: 'ok', lastSuccessAt: null, createdAt,
  };
}

const ITEMS = [
  itemOf('f_new', { addedAt: '2026-11-05T15:00:00.000Z', folder: 'menus' }),
  itemOf('f_old', { addedAt: '2026-11-03T15:00:00.000Z', folder: 'later_folder' }),
];

test('a folder this client doesn’t know is Not sorted yet', () => {
  expect(FOLDERS.map((folder) => folder.label)).toEqual([
    'Sales', 'Calendars', 'Menus and recipes', 'Inventory and orders', 'Staffing', 'Notes and pasted text', 'Other', 'Not sorted yet',
  ]);
  expect(['sales', 'calendars', 'notes', 'nonsense', ''].map(folderOf)).toEqual(['sales', 'calendars', 'notes', 'unsorted', 'unsorted']);
});

test('entries run newest first, a calendar among the items by when it was added, in Calendars', () => {
  const entries = entriesOf(ITEMS, [calendarOf('c_mid', '2026-11-04T15:00:00.000Z'), calendarOf('c_old', '2026-11-01T15:00:00.000Z')], false);
  expect(entries.map((entry) => [entry.key, entry.folder])).toEqual([
    ['f_new', 'menus'], ['c_c_mid', 'calendars'], ['f_old', 'unsorted'], ['c_c_old', 'calendars'],
  ]);
});

test('with an older page to load, a calendar older than the oldest item loaded waits for it', () => {
  const calendars = [calendarOf('c_mid', '2026-11-04T15:00:00.000Z'), calendarOf('c_old', '2026-11-01T15:00:00.000Z')];
  expect(entriesOf(ITEMS, calendars, true).map((entry) => entry.key)).toEqual(['f_new', 'c_c_mid', 'f_old']);
  // With no item loaded there is nothing to wait behind.
  expect(entriesOf([], calendars, true).map((entry) => entry.key)).toEqual(['c_c_mid', 'c_c_old']);
});

test('byFolder gives every folder in order, an empty one with none', () => {
  const grouped = byFolder(entriesOf(ITEMS, [calendarOf('c1', '2026-11-04T15:00:00.000Z')], false));
  expect(grouped.map(({ folder, entries }) => [folder.key, entries.map((entry) => entry.key)])).toEqual([
    ['sales', []], ['calendars', ['c_c1']], ['menus', ['f_new']], ['inventory', []], ['staffing', []], ['notes', []], ['other', []],
    ['unsorted', ['f_old']],
  ]);
});

test('the View is kept under a key per signed-in person, in a secure store’s characters', () => {
  expect(dataViewKey('6566a1b2c3d4e5f601234567')).toBe('townwise.dataView.6566a1b2c3d4e5f601234567');
  expect(dataViewKey('a.b/c')).toBe('townwise.dataView.a_b_c');
});
