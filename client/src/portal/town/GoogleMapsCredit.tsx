import { Text } from 'react-native';

import { useThemeMode } from '../shell/themeMode';
import { GOOGLE_MAPS, googleMapsCreditColor } from './research-copy';

// Google's text attribution for Places content shown beside the Competition card (D66, Places policies, checked
// 2026-11-19): the words "Google Maps" on one line (a no-break space), in one of the colors Google allows (#5E5E5E on
// light, white on dark), never translated. Native has no translate attribute; GoogleMapsCredit.web.tsx sets it.
export function GoogleMapsCredit(): React.JSX.Element {
  const mode = useThemeMode();
  return <Text style={{ color: googleMapsCreditColor(mode) }}>{GOOGLE_MAPS}</Text>;
}
