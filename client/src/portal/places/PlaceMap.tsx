import { useState } from 'react';
import { Image, StyleSheet } from 'react-native';

import { theme } from '../../theme';
import type { PlaceMap as PlaceMapData } from './map';

// The map at the top of the access request's confirm card, for the onboarding screens to mount. The image comes
// straight from Google (a signed Maps Static URL, see map.ts), at the 2:1 ratio of its logical size and never cropped
// or covered, so Google's logo in its bottom-left corner stays visible. The address and town lines carry the
// information: with no map, or when the image fails to load, nothing renders, never an empty box.

export function PlaceMap(props: { map: PlaceMapData; label: string }): React.JSX.Element | null {
  const { map } = props;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (map === null || failedUrl === map.url) return null;
  return (
    <Image
      source={{ uri: map.url }}
      style={[styles.map, { aspectRatio: map.width / map.height }]}
      resizeMode="cover"
      accessible
      role="img"
      aria-label={props.label}
      onError={() => { setFailedUrl(map.url); }}
    />
  );
}

const styles = StyleSheet.create({
  map: { width: '100%', backgroundColor: theme.color.panel, borderRadius: theme.radius.none },
});
