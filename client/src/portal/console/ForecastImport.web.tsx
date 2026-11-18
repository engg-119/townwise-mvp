import { useCallback, useId, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { hasCode } from '../errors';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { Messages, Notice } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Select } from '../ui/Select';
import { Heading, Small } from '../ui/text';
import {
  DRAFT_NOTE, importForecastRun, issuesOf, issueText, readChosenFile, STATUS_LABEL, summaryText, type FileRead, type StaffRun,
} from './forecasts';
import { problemOf } from './problems';
import type { OrgLocation, StaffOrg } from './schemas';

// Import a forecast (spec 16.4 P21 Forecasts), web only: staff choose a location and a run file, the browser reads it
// (refused unread over 2 MB, else File.text(), the size it will be sent at and the run file's shape), shows a summary to confirm, and only then sends it. The run lands as a
// draft. Problems are listed by path and code in words, the browser's at once and the server's after sending; never a
// value from the file. Native shows one line instead (ForecastImport.tsx).

export interface ForecastImportProps {
  org: StaffOrg;
  locations: readonly OrgLocation[];
  /** After a run is imported (or found already imported): the section reads its runs again. */
  onImported: (run: StaffRun) => Promise<void>;
}

const HELP = 'A run file (townwise.forecast-run/1) from modeling/export_forecast_run.py. It holds outputs only: ranges, dates and the model’s details. JSON, up to 256 KB.';

function importedLine(run: StaffRun): string {
  if (run.status === 'draft') return `Imported ${run.model.label} as a draft. Publish it below once you’ve checked it.`;
  return `This file was imported before. It is ${STATUS_LABEL[run.status].toLowerCase()}.`;
}

export function ForecastImport(props: ForecastImportProps): React.JSX.Element {
  const { org, locations, onImported } = props;
  const { api } = usePortal();
  const input = useRef<HTMLInputElement>(null);
  const helpId = `${useId().replace(/:/g, '')}-help`;
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [read, setRead] = useState<FileRead | null>(null);
  const [serverIssues, setServerIssues] = useState<readonly string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const send = useAction(useCallback(async (file: unknown, target: string) => {
    setServerIssues([]);
    let run: StaffRun;
    try {
      run = await importForecastRun(api, org.id, target, file);
    } catch (error) {
      if (error instanceof ApiError && hasCode(error, 400, 'invalid_forecast_file')) {
        setServerIssues(issuesOf(error.detail).map(issueText));
        return;
      }
      throw error;
    }
    setRead(null);
    setDone(importedLine(run));
    await onImported(run);
  }, [api, org.id, onImported]));

  async function choose(chosen: File): Promise<void> {
    setDone(null);
    setServerIssues([]);
    setRead(await readChosenFile(chosen));
  }

  if (locations.length === 0) {
    return (
      <Stack gap={12}>
        <Heading level={3}>Import a forecast</Heading>
        <Small>{`${org.name} has no location yet, so there is nothing to forecast.`}</Small>
      </Stack>
    );
  }
  const problem = problemOf(send.error);
  const locationName = locations.find((location) => location.id === locationId)?.name ?? 'this location';
  const readIssues = read !== null && !read.ok ? read.issues.map(issueText) : [];
  return (
    <Stack gap={12}>
      <Heading level={3}>Import a forecast</Heading>
      <View style={styles.location}>
        <Select
          label="Location"
          value={locationId}
          onChange={(value) => { setLocationId(value); }}
          items={locations.map((location) => ({ value: location.id, label: location.name }))}
        />
      </View>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: 'none' }}
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          // Clear the control so the same file can be chosen again.
          event.currentTarget.value = '';
          if (chosen !== undefined) void choose(chosen);
        }}
      />
      <Actions>
        <Button variant="outline" label="Choose a run file" describedBy={helpId} onPress={() => { input.current?.click(); }} />
      </Actions>
      <Small nativeID={helpId}>{HELP}</Small>
      {readIssues.length === 0 ? null : <Messages live="alert" items={readIssues} />}
      {read?.ok === true ? (
        <Stack gap={12}>
          <Small white>{`For ${locationName}: ${summaryText(read.summary)}`}</Small>
          <Small>{DRAFT_NOTE}</Small>
          {serverIssues.length === 0 ? null : <Messages live="alert" items={serverIssues} />}
          {problem === null ? null : <Messages live="alert" items={[problem.text]} />}
          <Actions>
            <Button
              label={send.pending ? 'Importing…' : 'Import'}
              accessibilityLabel={`Import for ${locationName}`}
              disabled={send.pending}
              onPress={() => { send.run(read.file, locationId); }}
            />
          </Actions>
        </Stack>
      ) : null}
      {done === null ? null : <Notice text={done} />}
    </Stack>
  );
}

const styles = StyleSheet.create({
  location: { maxWidth: 360 },
});
