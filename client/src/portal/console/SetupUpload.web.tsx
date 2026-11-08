import { useId, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { formatDate, plural } from '../format';
import { usePortal } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { LoadingLine, Messages } from '../ui/feedback';
import { useFocusMessage } from '../ui/messageFocus';
import { Stack } from '../ui/layout';
import { Select } from '../ui/Select';
import { Heading, Small } from '../ui/text';
import { checkProblemLine, COPY, readingLine, sendErrorOf, sendingLine, sendLabel } from '../upload/copy';
import { bodyBytes, MAX_BODY_BYTES, uploadBody, type CheckResult } from '../upload/days';
import { MatchStep } from '../upload/MatchStep';
import { useSalesFile } from '../upload/useSalesFile';
import { uploadSetupSales } from './api';
import type { OrgLocation, SetupUpload as SetupUploadAnswer } from './schemas';

// Upload daily totals in staff setup (spec 16.4 P21, D23, F10b), web only: staff choose a location and a daily sales
// export, and the browser reads it with P13's reader (upload/useSalesFile): choose, match columns, check, send. Only
// `{ days }` is sent (11.1), and it replaces the days it covers. Before and after sending the panel shows the day count
// and the first and last dates, never a figure: no totals, no day's values, no reason a day was left out, and nothing
// from the answer's calibration (D7). Native shows one line instead (SetupUpload.tsx).

export interface SetupUploadProps {
  org: { id: string; name: string };
  locations: readonly OrgLocation[];
  /** The refusals every setup write answers alike (409 org_not_in_setup, 404); true when the panel handled one. */
  settled: (error: unknown, location: { name: string }) => Promise<boolean>;
  /** After the days are saved: the page reads the organization again; false when that read found it deleted. */
  onSaved: () => Promise<boolean>;
}

const INTRO = 'Your browser reads the file here, and Townwise receives only each day’s date, guests and net sales. The days it covers replace the ones the location has. This page shows how many days and which dates, never a figure.';

/** The location a file was chosen for, fixed until the upload starts over. */
interface Target { id: string; name: string; coverage: OrgLocation['coverage'] }

function savedLines(name: string, answer: SetupUploadAnswer): string[] {
  const { upload, coverage } = answer;
  const lines = [`Saved ${plural(upload.dayCount, 'day', 'days')} for ${name}, ${formatDate(upload.firstDate)} to ${formatDate(upload.lastDate)}.`];
  if (coverage.firstDate !== null && coverage.lastDate !== null) {
    lines.push(`${name} now has ${plural(coverage.dayCount, 'day', 'days')}, ${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}.`);
  }
  return lines;
}

/** Step 3 for staff: the days as a count and two dates. */
function CheckDays(props: {
  result: CheckResult;
  target: Target;
  sendError: unknown;
  onSend: () => void;
  onBack: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  const { result, target } = props;
  const back = <Button variant="link" label="Back" onPress={props.onBack} />;
  const heading = <Heading level={3}>Check the days</Heading>;
  if (result.kind !== 'days') {
    return (
      <Stack gap={12}>
        {heading}
        <Messages live="alert" items={[checkProblemLine(result)]} />
        <Actions>{back}</Actions>
      </Stack>
    );
  }
  const first = result.days[0];
  const last = result.days[result.days.length - 1];
  const failure = props.sendError === null ? null : sendErrorOf(props.sendError);
  const left = result.excluded.length;
  const { coverage } = target;
  return (
    <Stack gap={12}>
      {heading}
      {first === undefined || last === undefined ? (
        <Messages live="status" items={[COPY.nothingToSend]} />
      ) : (
        <Small white>{`${plural(result.days.length, 'day', 'days')} for ${target.name}, ${formatDate(first.date)} to ${formatDate(last.date)}.`}</Small>
      )}
      {left === 0 ? null : <Small>{`${plural(left, 'day', 'days')} in this file can’t be sent, so ${left === 1 ? 'it is' : 'they are'} left out.`}</Small>}
      {coverage.dayCount > 0 && coverage.firstDate !== null && coverage.lastDate !== null ? (
        <Small>{`${target.name} already has ${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}. Days in both are replaced by this file.`}</Small>
      ) : null}
      {failure === null ? null : <Messages live="alert" items={[failure.text]} />}
      <Actions>
        {first === undefined || failure?.action === 'restart' ? null : <Button label={sendLabel(result.days.length)} onPress={props.onSend} />}
        {back}
        <Button variant="link" label="Choose another file" onPress={props.onRestart} />
      </Actions>
    </Stack>
  );
}

export function SetupUpload(props: SetupUploadProps): React.JSX.Element {
  const { org, locations, settled, onSaved } = props;
  const { api } = usePortal();
  const focusMessage = useFocusMessage();
  const input = useRef<HTMLInputElement>(null);
  const helpId = `${useId().replace(/:/g, '')}-help`;
  const [chosenId, setChosenId] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const sales = useSalesFile(target?.name ?? '');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const inflight = useRef(false);
  const current = locations.find((location) => location.id === chosenId) ?? locations[0];
  const { check, opened } = sales;

  function restart(): void {
    setSendError(null);
    setSaved(null);
    setTarget(null);
    sales.restart();
  }

  function choose(chosen: File): void {
    if (current === undefined) return;
    restart();
    setTarget({ id: current.id, name: current.name, coverage: current.coverage });
    void sales.open(chosen);
  }

  async function send(): Promise<void> {
    if (inflight.current || target === null || check?.kind !== 'days' || check.days.length === 0) return;
    inflight.current = true;
    setSending(true);
    setSendError(null);
    try {
      const body = uploadBody(check.days);
      // As P13: 3,660 days at the largest values fit the route's 256 KB; this guards a client bug.
      if (bodyBytes(body) > MAX_BODY_BYTES) throw new ApiError('http', 'The upload is larger than the route accepts.', { status: 413 });
      let answer: SetupUploadAnswer;
      try {
        answer = await uploadSetupSales(api, org.id, target.id, body);
      } catch (error) {
        if (await settled(error, target)) {
          restart();
          return;
        }
        throw error;
      }
      // The sending line stays up while the page reads the organization again, so the tables show the new days.
      const fresh = await onSaved();
      sales.forget();
      if (!fresh) return;
      // The Send button is gone, so focus moves to the line that says what was saved.
      focusMessage();
      setSaved(savedLines(target.name, answer));
    } catch (error) {
      setSendError(error);
    } finally {
      inflight.current = false;
      setSending(false);
    }
  }

  let content: React.ReactNode;
  if (current === undefined) {
    content = <Small>{`Add a location to ${org.name} first, then upload its daily totals.`}</Small>;
  } else if (sales.reading !== null) {
    content = <LoadingLine text={readingLine(sales.reading)} minHeight={120} />;
  } else if (sending && check?.kind === 'days') {
    content = <LoadingLine text={sendingLine(check.days.length)} minHeight={120} />;
  } else if (saved !== null) {
    content = (
      <Stack gap={12}>
        <Messages live="status" takesFocus items={saved} />
        <Actions><Button variant="outline" label="Upload another file" onPress={restart} /></Actions>
      </Stack>
    );
  } else if (target !== null && sales.step === 'match' && opened !== null) {
    content = (
      <Stack gap={12}>
        <Small white>{`For ${target.name}.`}</Small>
        <MatchStep
          columns={opened.columns}
          mapping={sales.mapping}
          onChange={sales.changeMapping}
          locationName={target.name}
          locationValues={sales.values}
          readingLine={readingLine(opened.size)}
          onCheck={() => { setSendError(null); void sales.checkTotals(); }}
          onBack={restart}
        />
      </Stack>
    );
  } else if (target !== null && sales.step === 'check' && check !== null) {
    content = (
      <CheckDays
        result={check}
        target={target}
        sendError={sendError}
        onSend={() => { void send(); }}
        onBack={() => { setSendError(null); sales.backToMatch(); }}
        onRestart={restart}
      />
    );
  } else {
    content = (
      <Stack gap={12}>
        <Small>{INTRO}</Small>
        <View style={styles.location}>
          <Select
            label="Upload for"
            value={current.id}
            onChange={setChosenId}
            items={locations.map((location) => ({ value: location.id, label: location.name }))}
          />
        </View>
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
            if (chosen !== undefined) choose(chosen);
          }}
        />
        {sales.error === null ? null : <Messages live="alert" items={[sales.error]} />}
        <Actions>
          <Button
            variant="outline"
            label={COPY.choose}
            accessibilityLabel={`${COPY.choose} for ${current.name}`}
            describedBy={helpId}
            onPress={() => { input.current?.click(); }}
          />
        </Actions>
        <Small nativeID={helpId}>{COPY.fileHelp}</Small>
      </Stack>
    );
  }

  return (
    <Stack gap={12}>
      <Heading level={3}>Upload daily totals</Heading>
      {content}
    </Stack>
  );
}

const styles = StyleSheet.create({
  location: { maxWidth: 360 },
});
