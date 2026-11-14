import { useEffect, useState } from 'react';

import { getItem } from '../../portal/data/api';
import { bytesOf, dataUrlOf, planFor } from '../../portal/data/item/open';
import { downloadRaw } from '../../portal/files/api';
import { usePortal } from '../../portal/PortalProvider';
import { sniffImage } from '../../portal/viewer/kinds';
import { isFileRef, PICTURE_MAX_BYTES } from '../attachments';
import type { AttachmentThumbProps } from './AttachmentThumb';

// A picture attached to the person's message, as a thumbnail at most 240px on a side (spec P25, D36). It is fetched
// as the item page fetches a picture (P27): the item is read, planFor decides (nothing under view-as, with stored
// files off, while uploading, once the original is gone, past the viewer's size cap, or unless the item answers
// canDownloadRaw), then the original's bytes are read and drawn from a data: URL typed by their signature, never by
// the name (the CSP's img-src allows data:, not blob:). A picture over 3.75 MB, which TownwiseAI never reads, gets no
// thumbnail, and a ref that isn't a well-formed file ref is never read. Anything else draws nothing, and the chip shows
// alone. A thumbnail drawn once is kept in memory by its ref for the page's life (per API client, so a new session
// starts empty), and showing the message again reads nothing; nothing is stored or logged. The chip names the file,
// so the picture itself is decorative.

const SIDE = 240;

/** The thumbnails drawn so far: for each API client, each picture's data: URL by its ref. */
const drawn = new WeakMap<object, Map<string, string>>();

function drawnWith(api: object): Map<string, string> {
  let urls = drawn.get(api);
  if (urls === undefined) {
    urls = new Map();
    drawn.set(api, urls);
  }
  return urls;
}

export function AttachmentThumb(props: AttachmentThumbProps): React.JSX.Element | null {
  const { api } = usePortal();
  const { locationId, fileRef } = props;
  const [shown, setShown] = useState<{ ref: string; src: string } | null>(null);
  const known = drawnWith(api).get(fileRef) ?? null;

  useEffect(() => {
    if (!isFileRef(fileRef) || drawnWith(api).has(fileRef)) return undefined;
    const controller = new AbortController();
    const live = (): boolean => !controller.signal.aborted;
    void (async () => {
      const item = await getItem(api, locationId, fileRef);
      const plan = planFor(item, 'raw', false);
      if (!live() || 'blocked' in plan || plan.viewer !== 'image' || item.file === null) return;
      if ((plan.sizeBytes ?? 0) > PICTURE_MAX_BYTES) return;
      const bytes = await bytesOf(await downloadRaw(api, locationId, { id: item.file.id, sizeBytes: plan.sizeBytes ?? 0 }, { signal: controller.signal }));
      const type = sniffImage(bytes);
      if (!live() || type === null) return;
      const src = dataUrlOf(bytes, type);
      drawnWith(api).set(fileRef, src);
      setShown({ ref: fileRef, src });
    })().catch(() => undefined);
    return () => { controller.abort(); };
  }, [api, locationId, fileRef]);

  const src = known ?? (shown?.ref === fileRef ? shown.src : null);
  if (src === null) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      data-testid="attachment-thumb"
      style={{ display: 'block', maxWidth: SIDE, maxHeight: SIDE, width: 'auto', height: 'auto', objectFit: 'contain' }}
    />
  );
}
