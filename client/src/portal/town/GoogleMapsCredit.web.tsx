import { useThemeMode } from '../shell/themeMode';
import { GOOGLE_MAPS, googleMapsCreditColor } from './research-copy';

// The web's Google Maps credit (GoogleMapsCredit.tsx is native's): the same words and colors, plus translate="no",
// which Google's Places policies ask for and react-native-web's Text doesn't pass through, and no wrapping.
export function GoogleMapsCredit(): React.JSX.Element {
  const mode = useThemeMode();
  return (
    <span translate="no" style={{ color: googleMapsCreditColor(mode), whiteSpace: 'nowrap' }}>
      {GOOGLE_MAPS}
    </span>
  );
}
