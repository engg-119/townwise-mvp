import { useEffect, useState } from 'react';

import { getItem } from '../../portal/data/api';
import { bytesOf, dataUrlOf, planFor } from '../../portal/data/item/open';
import { downloadRaw } from '../../portal/files/api';
import { usePortal } from '../../portal/PortalProvider';
import { sniffImage } from '../../portal/viewer/kinds';
import type { AttachmentThumbProps } from './AttachmentThumb';

// A picture attached to the person's message, as a thumbnail at most 240px on a side (spec P25, D36). It is fetched
// as the item page fetches a picture (P27): the item is read, planFor decides (nothing under view-as, with stored
// files off, while uploading, once the original is gone, past the viewer's size cap, or unless the item answers
// canDownloadRaw), then the original's bytes are read and drawn from a data: URL typed by their signature, never by
// the name (the CSP's img-src allows data:, not blob:). Anything else draws nothing, and the chip shows alone. The
// bytes stay in memory; nothing is stored or logged. The chip names the file, so the picture itself is decorative.

const SIDE = 240;

export function AttachmentThumb(props: AttachmentThumbProps): React.JSX.Element | null {
  const { api } = usePortal();
  const { locationId, fileRef } = props;
  const [shown, setShown] = useState<{ ref: string; src: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const live = (): boolean => !controller.signal.aborted;
    void (async () => {
      const item = await getItem(api, locationId, fileRef);
      const plan = planFor(item, 'raw', false);
      if (!live() || 'blocked' in plan || plan.viewer !== 'image' || item.file === null) return;
      const bytes = await bytesOf(await downloadRaw(api, locationId, { id: item.file.id, sizeBytes: plan.sizeBytes ?? 0 }, { signal: controller.signal }));
      const type = sniffImage(bytes);
      if (live() && type !== null) setShown({ ref: fileRef, src: dataUrlOf(bytes, type) });
    })().catch(() => undefined);
    return () => { controller.abort(); };
  }, [api, locationId, fileRef]);

  if (shown?.ref !== fileRef) return null;
  return (
    <img
      src={shown.src}
      alt=""
      draggable={false}
      data-testid="attachment-thumb"
      style={{ display: 'block', maxWidth: SIDE, maxHeight: SIDE, width: 'auto', height: 'auto', objectFit: 'contain' }}
    />
  );
}
