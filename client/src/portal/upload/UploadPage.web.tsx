import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { ids } from '../ui/aria';
import { Actions, Button, LinkButton } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { LoadingLine, Messages, ReadOnlyLine } from '../ui/feedback';
import { Columns, Panel, Stack } from '../ui/layout';
import { Body, Eyebrow, Heading, Mono, Small } from '../ui/text';
import { sendUpload, type UploadResponse } from './api';
import { CheckStep } from './CheckStep';
import { checkFile, guessColumns, lacksHeader, LocationValues, looksBinary, Profiler, type ColumnProfile } from './columns';
import { COPY, readingLine, sendingLine, stepLine } from './copy';
import { detectDelimiter, stripBom } from './csv';
import { bodyBytes, DayAggregator, latestDate, MAX_BODY_BYTES, uploadBody, type CheckResult, type Mapping } from './days';
import { MatchStep, type LocationValuesState } from './MatchStep';
import { ResultStep } from './ResultStep';
import { nextTask, scanText, type ScanOptions } from './scan';

// P13. Upload sales history on the web (spec 11, 16.3 P13, F11; the Portal-Upload board). The browser reads the
// file; only { days: [{ date, guests, netSalesCents }] } is sent, in one request (11.1, D10).
//
// The page never keeps the file's text. It keeps the File handle, and each read (the columns, the location
// column's values, the totals) calls File.text() again, parses in slices that give the browser its turn, and lets
// the text go when it ends. Between reads it holds only the header names and kinds, the location values once
// that column is named (D11), and the days. A successful send clears all of it, and so does leaving the page.
// Under view-as the page stays on step 1 with the file control disabled, so no client file is read into a staff
// browser (8, 15.5).

const RO_ID = 'upload-ro';
const HELP_ID = 'upload-file-help';

const EMPTY_MAPPING: Mapping = {
  rowMode: 'day', date: null, guests: null, netSales: null, location: null, locationValue: null, dateOrder: 'month_first',
};

const HOW: readonly [string, string][] = [
  ['Choose a file.', 'Your browser reads it here. Nothing is sent yet.'],
  ['Match columns.', 'Pick the date, guests and net sales columns. Townwise shows column names, not what’s in the cells. Only a location column’s values show, once you name that column.'],
  ['Check the totals.', 'Compare them with your point-of-sale system before anything is sent.'],
  ['Send.', 'One request with three values per day. The file itself never leaves this computer.'],
];

type Step = 'choose' | 'match' | 'check' | 'done';

interface Opened { size: number; columns: ColumnProfile[] }

/** A data slot in an illustration (`.slot`): the shape of a value, never a value. */
function Slot(props: { text: string; end?: boolean }): React.JSX.Element {
  return <View style={[styles.slot, props.end === true ? styles.slotEnd : null]}><Text style={styles.slotText}>{props.text}</Text></View>;
}

function HowList(): React.JSX.Element {
  return (
    <View role="list" aria-label="The four steps" style={styles.how}>
      {HOW.map(([lead, rest], index) => (
        <View key={lead} role="listitem" style={styles.howItem}>
          <Mono tone="text3" style={styles.howCounter}>{String(index + 1).padStart(2, '0')}</Mono>
          <Text style={styles.howText}><Text style={styles.howLead}>{lead}</Text>{` ${rest}`}</Text>
        </View>
      ))}
    </View>
  );
}

function ChooseStep(props: {
  readOnly: boolean;
  line: string;
  error: string | null;
  onFile: (file: File) => void;
  cancelHref: string;
}): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);
  const main = (
    <Stack gap={theme.space[5]}>
      <Heading level={3}>Choose a file</Heading>
      <Body>{COPY.intro}</Body>
      <ReadOnlyLine text={props.line} nativeID={RO_ID} />
      {props.error === null ? null : <Messages live="alert" items={[props.error]} />}
      {props.readOnly ? null : (
        <input
          ref={input}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          tabIndex={-1}
          aria-hidden="true"
          style={{ display: 'none' }}
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0];
            // Clear the control so the same file can be chosen again.
            event.currentTarget.value = '';
            if (chosen !== undefined) props.onFile(chosen);
          }}
        />
      )}
      <Actions>
        <Button
          variant="outline"
          label={COPY.choose}
          disabled={props.readOnly}
          describedBy={ids(props.readOnly && RO_ID, HELP_ID) ?? HELP_ID}
          onPress={() => { input.current?.click(); }}
        />
        <LinkButton href={props.cancelHref} label="Cancel" />
      </Actions>
      <Small nativeID={HELP_ID}>{COPY.fileHelp}</Small>
      <HowList />
    </Stack>
  );
  const side = (
    <Stack gap={theme.space[6]}>
      <Panel>
        <Stack gap={theme.space[2]}>
          <Eyebrow>Sent to Townwise</Eyebrow>
          <Heading level={3}>Three values per day</Heading>
        </Stack>
        <DataTable
          label="What Townwise receives for each day"
          columns={[{ key: 'date', label: 'Date' }, { key: 'guests', label: 'Guests', numeric: true }, { key: 'sales', label: 'Net sales', numeric: true }]}
          rows={[{ key: 'shape', cells: { date: <Slot text="{date}" />, guests: <Slot text="{guests}" end />, sales: <Slot text="{sales}" end /> } }]}
        />
        <Small>Nothing else leaves this computer: not the file’s name, its column names, its row count, its other columns or any other value in it.</Small>
      </Panel>
      <Stack gap={theme.space[3]}>
        <Eyebrow>What to export</Eyebrow>
        <Small>A daily summary is best: one row per day. One row per check or order works too; Townwise adds up the rows for each day.</Small>
        <Small>Item-level exports don’t work, because each item line repeats its check’s guest count.</Small>
        <Small>The file needs a date column, plus guest counts, net sales or both.</Small>
      </Stack>
    </Stack>
  );
  return <Columns main={main} side={side} gap={theme.space[8]} />;
}

export function UploadPage(): React.JSX.Element {
  const { location, org } = useLocation();
  const { api, reloadOrg } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [step, setStep] = useState<Step>('choose');
  /** The file's size while a read runs (“Reading {size} file…”). */
  const [reading, setReading] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [values, setValues] = useState<LocationValuesState>({ status: 'idle' });
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const file = useRef<File | null>(null);
  /** Bumped whenever the current file's reads stop mattering: another file, Back to step 1, a send, leaving. */
  const fileRun = useRef(0);
  const valuesRun = useRef(0);
  const inflight = useRef(false);
  const mounted = useRef(true);
  const saved = useRef(false);
  const reload = useRef(reloadOrg);
  const salesHref = locationHref(location.id, 'sales');

  useEffect(() => { reload.current = reloadOrg; }, [reloadOrg]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fileRun.current += 1;
      valuesRun.current += 1;
      file.current = null;
      // The location's coverage changed: the other tabs read it from the organization.
      if (saved.current) reload.current();
    };
  }, []);

  function scanOptions(run: number, valuesAt?: number): ScanOptions {
    return {
      pause: nextTask,
      cancelled: () => fileRun.current !== run || (valuesAt !== undefined && valuesRun.current !== valuesAt),
    };
  }

  /** Drops everything read from the current file. */
  function forget(): void {
    fileRun.current += 1;
    valuesRun.current += 1;
    file.current = null;
    setOpened(null);
    setMapping(EMPTY_MAPPING);
    setValues({ status: 'idle' });
    setCheck(null);
    setSendError(null);
    setReading(null);
  }

  function failRead(run: number, message: string): void {
    if (fileRun.current !== run) return;
    forget();
    setStep('choose');
    setFileError(message);
  }

  async function readText(chosen: File, run: number): Promise<string | null> {
    try {
      return await chosen.text();
    } catch {
      failRead(run, COPY.unreadable);
      return null;
    }
  }

  async function openFile(chosen: File): Promise<void> {
    if (readOnly) return;
    forget();
    setStep('choose');
    setFileError(null);
    const problem = checkFile(chosen);
    if (problem !== null) {
      setFileError(problem === 'too_large' ? COPY.tooLarge : COPY.notCsv);
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
    const name = location.name.trim().toLowerCase();
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
    setSendError(null);
    setReading(null);
    setStep('check');
  }

  async function send(): Promise<void> {
    if (readOnly || inflight.current || check?.kind !== 'days' || check.days.length === 0) return;
    inflight.current = true;
    setSending(true);
    setSendError(null);
    try {
      const body = uploadBody(check.days);
      // 3,660 days at the largest values are 230,590 bytes, under the route's 256 KB; this guards a client bug.
      if (bodyBytes(body) > MAX_BODY_BYTES) throw new ApiError('http', 'The upload is larger than the route accepts.', { status: 413 });
      const response = await sendUpload(api, location.id, body);
      saved.current = true;
      if (!mounted.current) {
        reload.current();
        return;
      }
      forget();
      setResult(response);
      setStep('done');
    } catch (error) {
      setSendError(error);
    } finally {
      inflight.current = false;
      setSending(false);
    }
  }

  function restart(): void {
    forget();
    setFileError(null);
    setStep('choose');
  }

  const stepNumber = step === 'choose' ? 1 : step === 'match' ? 2 : step === 'check' ? 3 : 4;
  let content: React.ReactNode;
  if (reading !== null) {
    content = <LoadingLine text={readingLine(reading)} minHeight={240} />;
  } else if (sending && check?.kind === 'days') {
    content = <LoadingLine text={sendingLine(check.days.length)} minHeight={240} />;
  } else if (step === 'match' && opened !== null) {
    content = (
      <MatchStep
        columns={opened.columns}
        mapping={mapping}
        onChange={changeMapping}
        locationName={location.name}
        locationValues={values}
        readingLine={readingLine(opened.size)}
        onCheck={() => { void checkTotals(); }}
        onBack={restart}
        cancelHref={salesHref}
      />
    );
  } else if (step === 'check' && check !== null) {
    content = (
      <CheckStep
        result={check}
        role={org.role}
        coverage={location.coverage}
        sendError={sendError}
        onSend={() => { void send(); }}
        onRestart={restart}
        onBack={() => { setCheck(null); setSendError(null); setStep('match'); }}
        cancelHref={salesHref}
      />
    );
  } else if (step === 'done' && result !== null) {
    content = <ResultStep result={result} role={org.role} locationId={location.id} locationName={location.name} />;
  } else {
    content = <ChooseStep readOnly={readOnly} line={line} error={fileError} onFile={(chosen) => { void openFile(chosen); }} cancelHref={salesHref} />;
  }

  return (
    <Stack gap={theme.space[8]}>
      <Stack gap={theme.space[2]}>
        <Heading>{COPY.heading}</Heading>
        <Mono>{stepLine(stepNumber)}</Mono>
      </Stack>
      {content}
    </Stack>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  slot: { alignSelf: 'flex-start', borderWidth: 1, borderStyle: 'dashed', borderColor: c.line, paddingHorizontal: 5 },
  slotEnd: { alignSelf: 'flex-end' },
  slotText: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  how: { borderTopWidth: 1, borderTopColor: c.border },
  howItem: { flexDirection: 'row', columnGap: theme.space[2], paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  howCounter: { width: 28, lineHeight: 20 },
  howText: { ...theme.type.small, color: c.text2, flex: 1, minWidth: 0 },
  howLead: { ...theme.type.ui, color: c.white },
});
