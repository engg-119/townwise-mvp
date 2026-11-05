import { UploadPage } from '../../../../../../../src/portal/upload/UploadPage';

// P13 Upload sales history (/locations/[locationId]/sales/upload, members; web only, D20): docs/portal/spec.md 11
// and 16.3. Rendered inside the location layout, which draws the header and tabs above it. The web page is
// src/portal/upload/UploadPage.web.tsx; native shows where to upload instead.
export default function Upload(): React.JSX.Element {
  return <UploadPage />;
}
