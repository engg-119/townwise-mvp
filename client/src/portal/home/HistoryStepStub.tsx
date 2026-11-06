import { Platform } from 'react-native';

import { useReadOnly } from '../PortalProvider';
import { UploadAction } from '../locations/parts';
import { useLocation } from '../shell/LocationShell';
import { Actions } from '../ui/Button';
import { ReadOnlyLine } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Eyebrow, Heading, Small } from '../ui/text';

// A stand-in for session 54's onboarding/HistoryStep (see onboarding.ts), deleted when 54's merges. It offers only
// what exists today: the browser upload (P13, web; native says where to upload). It reads the location from the
// layout, as 54's will, and under view-as the upload is disabled with the read-only line (web; native uploads nowhere).

const READ_ONLY_ID = 'home-history-step-ro';

export function HistoryStep(): React.JSX.Element {
  const { location } = useLocation();
  const { readOnly, line } = useReadOnly();
  const readOnlyId = readOnly && Platform.OS === 'web' ? READ_ONLY_ID : null;
  return (
    <Panel label="Add your sales history">
      <Stack gap={8}>
        <Eyebrow>Step 3</Eyebrow>
        <Heading level={3}>Add your sales history</Heading>
      </Stack>
      <Small>Export a daily summary from your point-of-sale system and upload it. Home then compares each week with the same week in past years.</Small>
      <Actions>
        <UploadAction locationId={location.id} variant="primary" readOnlyId={readOnlyId} />
      </Actions>
      {readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />}
    </Panel>
  );
}
