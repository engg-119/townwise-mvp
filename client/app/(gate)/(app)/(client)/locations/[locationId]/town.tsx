import { View } from 'react-native';

import { townLabel } from '../../../../../../src/portal/format';
import { useLocation } from '../../../../../../src/portal/shell/LocationShell';
import { ResearchSection } from '../../../../../../src/portal/town/ResearchSection';
import { TownProfile } from '../../../../../../src/portal/town/TownProfile';

// P15 Town (/locations/[locationId]/town, members): docs/portal/spec.md 16.3 and 13. The profile is bundled public
// data (no request), with the chart on web and its text and table on native (D21); a town outside the twelve gets
// the honest gap line. Under it (D66) the town research section and the Competition card (`ResearchSection`), whose
// writes are disabled or hidden under view-as.
export default function TownTab(): React.JSX.Element {
  const { location, org } = useLocation();
  return (
    <View>
      <TownProfile town={location.town} heading={townLabel(location.town)} />
      <ResearchSection key={location.id} location={location} org={org} />
    </View>
  );
}
