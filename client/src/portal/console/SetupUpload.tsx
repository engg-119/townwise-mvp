import { Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import type { OrgLocation } from './schemas';

// Upload daily totals in staff setup on native (spec 16.4 P21, D20): files are read on a computer, so native says
// so. The web version is SetupUpload.web.tsx.

export interface SetupUploadProps {
  org: { id: string; name: string };
  locations: readonly OrgLocation[];
  settled: (error: unknown, location: { name: string }) => Promise<boolean>;
  onSaved: () => Promise<boolean>;
}

export function SetupUpload(props: SetupUploadProps): React.JSX.Element {
  return (
    <Stack gap={12}>
      <Heading level={3}>Upload daily totals</Heading>
      <Small>{`Upload daily totals for ${props.org.name} from a computer.`}</Small>
    </Stack>
  );
}
