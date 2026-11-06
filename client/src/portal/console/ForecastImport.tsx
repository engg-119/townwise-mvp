import { Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import type { StaffRun } from './forecasts';
import type { OrgLocation, StaffOrg } from './schemas';

// Import a forecast on native (spec 16.4 P21 Forecasts): run files are read on a computer, so native says so.
// The web version is ForecastImport.web.tsx.

export interface ForecastImportProps {
  org: StaffOrg;
  locations: readonly OrgLocation[];
  onImported: (run: StaffRun) => Promise<void>;
}

export function ForecastImport(props: ForecastImportProps): React.JSX.Element {
  return (
    <Stack gap={12}>
      <Heading level={3}>Import a forecast</Heading>
      <Small>{`Import a forecast for ${props.org.name} from a computer.`}</Small>
    </Stack>
  );
}
