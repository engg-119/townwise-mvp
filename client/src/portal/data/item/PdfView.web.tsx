import { useEffect, useRef } from 'react';

import { theme } from '../../../theme';

// A PDF on its item page (P27), in the browser's own PDF viewer: an <iframe> on a blob: URL of the fetched bytes,
// typed application/pdf so the browser reads them as nothing else. The CSP's frame-src allows blob: for this
// (client/MODULE.md, ## Security). No sandbox attribute: browsers refuse to draw a PDF in a sandboxed frame. The URL
// is made and revoked by one effect and handed to the frame directly, so it never outlives the view.

export function PdfView(props: { bytes: Uint8Array; title: string }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([props.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    if (frame.current !== null) frame.current.src = url;
    return () => { URL.revokeObjectURL(url); };
  }, [props.bytes]);
  return (
    <iframe
      ref={frame}
      title={props.title}
      style={{
        width: '100%', height: '80vh', minHeight: 480, display: 'block', boxSizing: 'border-box', border: `1px solid ${theme.color.border}`,
        background: theme.color.panel,
      }}
    />
  );
}
