import { useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../../theme';
import type { PlaceMap as PlaceMapData } from './map';

// The map at the top of the access request's confirm card, and the places checklist's one map of every checked place. The image comes
// straight from Google (a signed Maps Static URL, see map.ts), at the 2:1 ratio of its logical size and never cropped
// or covered, so Google's logo in its bottom-left corner stays visible. The address and town lines carry the
// information: with no map, or when the image fails to load, nothing renders, never an empty box. `frame` sizes a
// box around the image, such as the checklist's column up to 640 wide, which goes with the image. `onFailed` tells the
// page an image failed, so a legend beside it can drop its letters (settings/LocationsMap.tsx).

export function PlaceMap(props: {
  map: PlaceMapData; label: string; frame?: StyleProp<ViewStyle>; onFailed?: (url: string) => void;
}): React.JSX.Element | null {
  const { map } = props;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (map === null || failedUrl === map.url) return null;
  const image = (
    <Image
      source={{ uri: map.url }}
      style={[styles.map, { aspectRatio: map.width / map.height }]}
      resizeMode="cover"
      accessible
      role="img"
      aria-label={props.label}
      onError={() => { setFailedUrl(map.url); props.onFailed?.(map.url); }}
    />
  );
  return props.frame === undefined ? image : <View style={props.frame}>{image}</View>;
}

const styles = StyleSheet.create({
  map: { width: '100%', backgroundColor: theme.color.panel, borderRadius: theme.radius.none },
});
