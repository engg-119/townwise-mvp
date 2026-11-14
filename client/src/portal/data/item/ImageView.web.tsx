import { useMemo } from 'react';

import { region } from './dom.web';
import { dataUrlOf, type ImageType } from './open';

// A picture on its item page (P27): an <img> on a data: URL built from the fetched bytes, typed by their signature
// (kinds.ts sniffImage), never by the file's name. The CSP's img-src allows data: and not blob:, so the page builds
// no object URL for it. Only PNG, JPEG, GIF and WebP get here; an SVG never does.

export function ImageView(props: { bytes: Uint8Array; type: ImageType; alt: string }): React.JSX.Element {
  const src = useMemo(() => dataUrlOf(props.bytes, props.type), [props.bytes, props.type]);
  return (
    <div style={{ ...region, maxHeight: 'none', padding: 16 }}>
      <img src={src} alt={props.alt} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
    </div>
  );
}
