import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { hasCode } from '../errors';
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
import { COPY, readingLine, sendingLine, stepLine } from './copy';
import { bodyBytes, MAX_BODY_BYTES, uploadBody } from './days';
import { MatchStep } from './MatchStep';
import { ResultStep } from './ResultStep';
import { useSalesFile } from './useSalesFile';

// P13. Upload sales history on the web (spec 11, 16.3 P13, F11; the Portal-Upload board). The browser reads the
// file; only { days: [{ date, guests, netSalesCents }] } is sent, in one request (11.1, D10).
//
// The page never keeps the file's text: useSalesFile reads it, holds only the header names and kinds, the location
// values once that column is named (D11), and the days. A successful send clears all of it, and so does leaving the page.
// Under view-as the page stays on step 1 with the file control disabled, so no client file is read into a staff
// browser (8, 15.5).

const RO_ID = 'upload-ro';
const HELP_ID = 'upload-file-help';

const HOW: readonly [string, string][] = [
  ['Choose a file.', 'Your browser reads it here. Nothing is sent yet.'],
  ['Match columns.', 'Pick the date, guests and net sales columns. Townwise shows column names, not what’s in the cells. Only a location column’s values show, once you name that column.'],
  ['Check the totals.', 'Compare them with your point-of-sale system before anything is sent.'],
  ['Send.', 'One request with three values per day. The file itself never leaves this computer.'],
];

type Step = 'choose' | 'match' | 'check' | 'done';

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
  const sales = useSalesFile(location.name);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const inflight = useRef(false);
  const mounted = useRef(true);
  /** The organization's copy of this location is out of date: an upload saved, or the location is gone (404). */
  const stale = useRef(false);
  const reload = useRef(reloadOrg);
  const salesHref = locationHref(location.id, 'sales');
  const { check, opened } = sales;
  const step: Step = result === null ? sales.step : 'done';

  useEffect(() => { reload.current = reloadOrg; }, [reloadOrg]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Locations and this page read the location's coverage from the organization, so it is read again once this
      // page closes. Not at once: a failed read shows the layout's error in place of the result.
      if (stale.current) reload.current();
    };
  }, []);

  function openFile(chosen: File): void {
    if (readOnly) return;
    setSendError(null);
    void sales.open(chosen);
  }

  function checkTotals(): void {
    setSendError(null);
    void sales.checkTotals();
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
      stale.current = true;
      if (!mounted.current) {
        reload.current();
        return;
      }
      sales.forget();
      setResult(response);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) {
        stale.current = true;
        // Left while the send ran: the cleanup has already run, so the organization is read again here.
        if (!mounted.current) {
          reload.current();
          return;
        }
      }
      setSendError(error);
    } finally {
      inflight.current = false;
      setSending(false);
    }
  }

  function restart(): void {
    setSendError(null);
    sales.restart();
  }

  const stepNumber = step === 'choose' ? 1 : step === 'match' ? 2 : step === 'check' ? 3 : 4;
  let content: React.ReactNode;
  if (sales.reading !== null) {
    content = <LoadingLine text={readingLine(sales.reading)} minHeight={240} />;
  } else if (sending && check?.kind === 'days') {
    content = <LoadingLine text={sendingLine(check.days.length)} minHeight={240} />;
  } else if (step === 'match' && opened !== null) {
    content = (
      <MatchStep
        columns={opened.columns}
        mapping={sales.mapping}
        onChange={sales.changeMapping}
        locationName={location.name}
        locationValues={sales.values}
        readingLine={readingLine(opened.size)}
        onCheck={checkTotals}
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
        offDayCount={location.offDayCount ?? 0}
        sendError={sendError}
        onSend={() => { void send(); }}
        onRestart={restart}
        onBack={() => { setSendError(null); sales.backToMatch(); }}
        cancelHref={salesHref}
      />
    );
  } else if (step === 'done' && result !== null) {
    content = <ResultStep result={result} role={org.role} locationId={location.id} locationName={location.name} />;
  } else {
    content = <ChooseStep readOnly={readOnly} line={line} error={sales.error} onFile={openFile} cancelHref={salesHref} />;
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
