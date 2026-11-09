import { useEffect, useRef, useState } from 'react';

import { checkFile, guessColumns, lacksHeader, LocationValues, looksBinary, Profiler, type ColumnProfile } from './columns';
import { COPY } from './copy';
import { detectDelimiter, stripBom } from './csv';
import { DayAggregator, latestDate, type CheckResult, type Mapping } from './days';
import type { LocationValuesState } from './MatchStep';
import { nextTask, scanText, type ScanOptions } from './scan';

// A daily-totals file read in the browser (spec 11.1, 11.2 steps 1 to 3), shared by P13 (UploadPage.web.tsx) and the
// staff setup upload on P21 (console/SetupUpload.web.tsx). The caller sends the days it ends with.
//
// It never keeps the file's text. It keeps the File handle, and each read (the columns, the location column's
// values, the totals) calls File.text() again, parses in slices that give the browser its turn, and lets the text go
// when it ends. Between reads it holds only the header names and kinds, the location values once that column is named
// (D11), and the days. `forget()` drops all of it, and so does unmounting.

export type FileStep = 'choose' | 'match' | 'check';

export interface OpenedFile { size: number; columns: ColumnProfile[] }

export const EMPTY_MAPPING: Mapping = {
  rowMode: 'day', date: null, guests: null, netSales: null, location: null, locationValue: null, dateOrder: 'month_first',
};

export interface SalesFile {
  step: FileStep;
  /** The file's size while a read runs (“Reading {size} file…”). */
  reading: number | null;
  /** Why the chosen file can't be used, on step 1. */
  error: string | null;
  opened: OpenedFile | null;
  mapping: Mapping;
  values: LocationValuesState;
  check: CheckResult | null;
  /** Step 1 to 2: reads the header and profiles the columns. */
  open: (chosen: File) => Promise<void>;
  changeMapping: (next: Mapping) => void;
  /** Step 2 to 3: adds the rows up per day. */
  checkTotals: () => Promise<void>;
  /** Step 3 back to 2. */
  backToMatch: () => void;
  /** Drops everything read from the current file, and stops its reads. */
  forget: () => void;
  /** Back to step 1 with nothing read. */
  restart: () => void;
}

/** `locationName` preselects the location column's value that is this location, if the file uses it. */
export function useSalesFile(locationName: string): SalesFile {
  const [step, setStep] = useState<FileStep>('choose');
  const [reading, setReading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [values, setValues] = useState<LocationValuesState>({ status: 'idle' });
  const [check, setCheck] = useState<CheckResult | null>(null);
  const file = useRef<File | null>(null);
  /** Bumped whenever the current file's reads stop mattering: another file, Back to step 1, a send, leaving. */
  const fileRun = useRef(0);
  const valuesRun = useRef(0);

  useEffect(() => () => {
    fileRun.current += 1;
    valuesRun.current += 1;
    file.current = null;
  }, []);

  function scanOptions(run: number, valuesAt?: number): ScanOptions {
    return {
      pause: nextTask,
      cancelled: () => fileRun.current !== run || (valuesAt !== undefined && valuesRun.current !== valuesAt),
    };
  }

  function forget(): void {
    fileRun.current += 1;
    valuesRun.current += 1;
    file.current = null;
    setOpened(null);
    setMapping(EMPTY_MAPPING);
    setValues({ status: 'idle' });
    setCheck(null);
    setReading(null);
  }

  function failRead(run: number, message: string): void {
    if (fileRun.current !== run) return;
    forget();
    setStep('choose');
    setError(message);
  }

  async function readText(chosen: File, run: number): Promise<string | null> {
    try {
      return await chosen.text();
    } catch {
      failRead(run, COPY.unreadable);
      return null;
    }
  }

  async function open(chosen: File): Promise<void> {
    forget();
    setStep('choose');
    setError(null);
    const problem = checkFile(chosen);
    if (problem !== null) {
      setError(problem === 'too_large' ? COPY.tooLarge : COPY.notCsv);
      return;
    }
    const run = fileRun.current;
    setReading(chosen.size);
    const text = await readText(chosen, run);
    if (text === null || fileRun.current !== run) return;
    if (looksBinary(text)) {
      failRead(run, COPY.notCsv);
      return;
    }
    const found: { profiler: Profiler | null } = { profiler: null };
    const outcome = await scanText(text, {
      header: (cells) => {
        if (cells === null || lacksHeader(cells)) return false;
        found.profiler = new Profiler(cells);
        return true;
      },
      row: (cells) => {
        found.profiler?.add(cells);
        return true;
      },
    }, scanOptions(run));
    if (outcome === 'cancelled') return;
    if (found.profiler === null) {
      failRead(run, COPY.noHeader);
      return;
    }
    if (outcome.unterminated) {
      failRead(run, COPY.notCsv);
      return;
    }
    const columns = found.profiler.finish();
    const guess = guessColumns(columns.map((column) => column.name));
    file.current = chosen;
    setOpened({ size: chosen.size, columns });
    setMapping({ ...EMPTY_MAPPING, ...guess, dateOrder: (guess.date === null ? null : columns[guess.date]?.order) ?? 'month_first' });
    setReading(null);
    setStep('match');
  }

  async function loadLocationValues(column: number): Promise<void> {
    const chosen = file.current;
    if (chosen === null) return;
    valuesRun.current += 1;
    const run = fileRun.current;
    const valuesAt = valuesRun.current;
    setValues({ status: 'loading' });
    const text = await readText(chosen, run);
    if (text === null) return;
    const collector = new LocationValues(column);
    const outcome = await scanText(text, { header: () => true, row: (cells) => collector.add(cells) }, scanOptions(run, valuesAt));
    if (outcome === 'cancelled') return;
    const list = collector.values();
    setValues({ status: 'ready', values: list, more: collector.more });
    // Preselect the value that is this location's name, if the file uses it.
    const name = locationName.trim().toLowerCase();
    const match = list.find((value) => value.toLowerCase() === name);
    if (match !== undefined) {
      setMapping((current) => (current.location === column && current.locationValue === null ? { ...current, locationValue: match } : current));
    }
  }

  function changeMapping(next: Mapping): void {
    if (next.location !== mapping.location) {
      if (next.location === null) {
        valuesRun.current += 1;
        setValues({ status: 'idle' });
      } else {
        void loadLocationValues(next.location);
      }
    }
    setMapping(next);
  }

  async function checkTotals(): Promise<void> {
    const chosen = file.current;
    if (chosen === null) return;
    const run = fileRun.current;
    const current = mapping;
    setReading(chosen.size);
    const text = await readText(chosen, run);
    if (text === null) return;
    const days = new DayAggregator(current, latestDate(new Date()), detectDelimiter(stripBom(text)));
    const outcome = await scanText(text, { header: () => true, row: (cells, row) => { days.add(cells, row); return true; } }, scanOptions(run));
    if (outcome === 'cancelled') return;
    setCheck(days.finish());
    setReading(null);
    setStep('check');
  }

  function backToMatch(): void {
    setCheck(null);
    setStep('match');
  }

  function restart(): void {
    forget();
    setError(null);
    setStep('choose');
  }

  return { step, reading, error, opened, mapping, values, check, open, changeMapping, checkTotals, backToMatch, forget, restart };
}
