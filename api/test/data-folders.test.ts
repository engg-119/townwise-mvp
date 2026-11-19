// Your data's folders (D61, src/data/folders.ts): the order of the rules, on synthetic records only. Nothing here reads
// a name: two files that differ only by name land in the same folder.
import { describe, expect, it } from 'vitest';

import { AI_KIND_FOLDERS, DATA_FOLDERS, folderOf } from '../src/data/folders.ts';
import type { DataItemRecord } from '../src/data/library.ts';
import type { FileRecord } from '../src/stores/files.ts';

const ID = 'ab'.repeat(12);

const FILE = {
  id: ID, purpose: 'reference', name: 'Sentinel-name sales menu calendar.txt', calendarImport: null, folder: null, addedVia: null, source: null, ai: null,
} as unknown as FileRecord;

function fileItem(over: Partial<Record<keyof FileRecord, unknown>> = {}): DataItemRecord {
  return { ref: { type: 'file', id: ID }, file: { ...FILE, ...over } } as unknown as DataItemRecord;
}

const at = new Date(0);
const doneRead = (kind: string): unknown => ({ status: 'done', result: { kind } });

describe('folderOf', () => {
  it('lists the folders in the order Your data shows them', () => {
    expect(DATA_FOLDERS).toEqual(['sales', 'calendars', 'menus', 'inventory', 'staffing', 'notes', 'other', 'unsorted']);
    expect(AI_KIND_FOLDERS).toEqual({ sales: 'sales', calendar: 'calendars', menu: 'menus', inventory: 'inventory', staffing: 'staffing', other: 'other' });
  });

  it('files by the rules, in order', () => {
    const cases: [string, DataItemRecord, string][] = [
      ['a sales upload', { ref: { type: 'upload', id: ID }, file: null } as unknown as DataItemRecord, 'sales'],
      ['a sales upload read from a file', { ref: { type: 'upload', id: ID }, file: { ...FILE, folder: 'menus' } } as unknown as DataItemRecord, 'sales'],
      ['a sales file kept unread', fileItem({ purpose: 'history', folder: 'notes' }), 'sales'],
      ['a calendar file added', fileItem({ calendarImport: { state: 'added', at }, folder: 'notes', ai: doneRead('menu') }), 'calendars'],
      ['a calendar file refused for the limit', fileItem({ calendarImport: { state: 'refused', code: 'calendar_limit', at } }), 'calendars'],
      ['an .ics file that is no calendar', fileItem({ calendarImport: { state: 'refused', code: 'not_calendar', at } }), 'unsorted'],
      ['its own folder over a read', fileItem({ folder: 'inventory', ai: doneRead('menu') }), 'inventory'],
      ['text TownwiseAI kept before folders', fileItem({ addedVia: 'townwise_ai' }), 'notes'],
      ['a read’s summary item before folders', fileItem({ source: { via: 'ai_file', fileId: ID } }), 'notes'],
      ['a done read', fileItem({ ai: doneRead('staffing') }), 'staffing'],
      ['a read still running', fileItem({ ai: { status: 'reading', result: null } }), 'unsorted'],
      ['an undone read', fileItem({ ai: { status: 'undone', result: { kind: 'menu' } } }), 'unsorted'],
      ['nothing known', fileItem(), 'unsorted'],
    ];
    for (const [name, item, folder] of cases) expect({ name, folder: folderOf(item) }).toEqual({ name, folder });
  });

  it('never reads the name', () => {
    expect(folderOf(fileItem({ name: 'Sales history 2026.csv' }))).toBe('unsorted');
    expect(folderOf(fileItem({ name: 'Dinner menu.pdf' }))).toBe('unsorted');
  });
});
