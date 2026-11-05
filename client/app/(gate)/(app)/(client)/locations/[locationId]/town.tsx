import { townLabel } from '../../../../../../src/portal/format';
import { useLocation } from '../../../../../../src/portal/shell/LocationShell';
import { TownProfile } from '../../../../../../src/portal/town/TownProfile';

// P15 Town (/locations/[locationId]/town, members): docs/portal/spec.md 16.3 and 13. The profile is bundled public
// data (no request), with the chart on web and its text and table on native (D21); a town outside the twelve gets
// the honest gap line. It has no writes, so view-as shows it unchanged.
export default function TownTab(): React.JSX.Element {
  const { location } = useLocation();
  return <TownProfile town={location.town} heading={townLabel(location.town)} />;
}
