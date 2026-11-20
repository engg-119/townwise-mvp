import { theme } from '../../theme';
import { Stack } from '../ui/layout';
import { Body, Heading } from '../ui/text';
import { COPY } from './copy';

// P13 on iOS and Android. Upload is web only (D20): the apps have a file picker since D41, but the upload's parser,
// column mapper and stored-file chunked upload use browser file APIs, so the page says where to upload instead.
// UploadPage.web.tsx is the upload.
export function UploadPage(): React.JSX.Element {
  return (
    <Stack gap={theme.space[3]}>
      <Heading>{COPY.heading}</Heading>
      <Body>{COPY.native}</Body>
    </Stack>
  );
}
