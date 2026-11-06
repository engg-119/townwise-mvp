// The AI column step's frozen request parts (spec 11A): the system prompt and the answer's schema. The model sees one
// redacted profile (profile.ts) and names the guests and net sales columns by index, or none. It never sees a row.
import { z } from 'zod';

export const EXTRACT_MODEL = 'claude-opus-5-5';
export const EXTRACT_MAX_TOKENS = 8000;
export const EXTRACT_TIMEOUT_MS = 60_000;

export const SYSTEM_PROMPT = [
  'You help Townwise read a restaurant\'s sales export. You are given one table\'s columns: each column\'s index, its',
  'header text, the kind of values it holds, how filled it is, how many distinct values it has, and for number columns',
  'whether the values are whole and the order of magnitude of the median. You also get up to 15 rows in which every',
  'cell is replaced by a token such as <date:iso>, <int>, <decimal>, <money>, <text> or <empty>. You never see the data.',
  '',
  'Name the column that holds the number of guests (covers, party size added up per day or per check) and the column',
  'that holds net sales (sales after discounts and before tax and tips), by index, or null when the table has none.',
  'Only a number column can be either. Never pick gross sales, tax, tips, discounts, payments or item quantities.',
  'Say confidence "high" only when the headers make the choice clear; otherwise "low", and Townwise will ask the owner.',
].join('\n');

export const columnsAnswer = z.object({
  guests: z.number().int().nullable(),
  netSales: z.number().int().nullable(),
  confidence: z.enum(['high', 'low']),
});

export type ColumnChoice = z.infer<typeof columnsAnswer>;
