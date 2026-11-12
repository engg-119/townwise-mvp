import { Actions, Button } from '../../ui/Button';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import { ITEM } from './copy';

// A PDF on its item page (P27): a line and Open PDF, which opens the fetched bytes in a new tab, in the browser's own
// PDF viewer. The page draws no frame: in Chrome a link in a PDF framed here would navigate the whole Townwise tab,
// and a sandboxed frame draws no PDF at all. The click makes a blob: URL typed application/pdf, so the browser reads
// the bytes as nothing else, and opens it with noopener, so the new tab has no handle on this one. It happens in the
// click itself, with the bytes already fetched, so a popup blocker lets it through. A new tab is a navigation, which no
// CSP directive here governs, so no header changes (client/MODULE.md, ## Security). The URL is revoked after
// REVOKE_AFTER_MS, as files/download.web.ts revokes its own, so a slow tab still finds it.

const REVOKE_AFTER_MS = 40_000;

function openPdf(bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => { URL.revokeObjectURL(url); }, REVOKE_AFTER_MS);
}

export function PdfView(props: { bytes: Uint8Array; name: string }): React.JSX.Element {
  return (
    <Stack>
      <Small>{ITEM.pdfLine}</Small>
      <Actions>
        <Button variant="outline" label={ITEM.openPdf} accessibilityLabel={`${ITEM.openPdf}: ${props.name}`} onPress={() => { openPdf(props.bytes); }} />
      </Actions>
    </Stack>
  );
}
