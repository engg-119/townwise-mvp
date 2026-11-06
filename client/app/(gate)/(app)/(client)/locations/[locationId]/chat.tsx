import { Redirect, usePathname } from 'expo-router';

import { locationHref, locationIdOf } from '../../../../../../src/portal/routing';

// The tuning chat's old address (/locations/[locationId]/chat). TownwiseAI lives at .../agent (P25), so old links
// and bookmarks land there. The id is read from the path, as the layout reads it.
export default function ChatRedirect(): React.JSX.Element {
  const locationId = locationIdOf(usePathname());
  return <Redirect href={locationId === null ? '/dashboard' : locationHref(locationId, 'agent')} />;
}
