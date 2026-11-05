import { theme } from '../../theme';
import { formatCount, formatDate } from '../format';
import { locationHref } from '../routing';
import type { Role } from '../schemas';
import { Actions, LinkButton } from '../ui/Button';
import { DefinitionList } from '../ui/DataTable';
import { Messages } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Body, Eyebrow, Heading } from '../ui/text';
import type { UploadResponse } from './api';
import { calibrationLine, COPY, resultLines } from './copy';

// Step 4, the result (spec 11.2 step 4): the saved counts by role, then the calibration state with the data
// checks (14.1), and the links to the sales data and to notes. Nothing from the file is left on the page.

export function ResultStep(props: { result: UploadResponse; role: Role; locationId: string; locationName: string }): React.JSX.Element {
  const { upload, coverage, calibration } = props.result;
  const date = (value: string | null): string => (value === null ? 'None' : formatDate(value));
  return (
    <Stack gap={theme.space[6]}>
      <Messages live="status" items={resultLines(props.role, props.locationName, upload)} />
      <Panel label="Calibration">
        <Stack gap={theme.space[2]}>
          <Eyebrow>Calibration</Eyebrow>
          <Heading level={3}>Not calibrated yet</Heading>
        </Stack>
        <Body>{calibrationLine(calibration)}</Body>
        <DefinitionList
          mono
          items={[
            { term: 'Days with data', value: formatCount(coverage.dayCount) },
            { term: 'First day', value: date(coverage.firstDate) },
            { term: 'Last day', value: date(coverage.lastDate) },
            { term: 'Missing days in between', value: formatCount(coverage.missingDays) },
            { term: 'Days with guests', value: formatCount(coverage.guestsDayCount) },
            { term: 'Days with net sales', value: formatCount(coverage.netSalesDayCount) },
            { term: 'Last upload', value: `${formatDate(upload.uploadedAt)} by ${upload.uploadedByEmail}` },
          ]}
        />
      </Panel>
      <Actions>
        <LinkButton variant="primary" href={locationHref(props.locationId, 'sales')} label={COPY.seeSales} />
        <LinkButton href={locationHref(props.locationId, 'notes')} label={COPY.addNotes} />
      </Actions>
    </Stack>
  );
}
