// A picture's thumbnail on an attachment chip in the person's bubble is web only (AttachmentThumb.web.tsx): the item
// page draws stored pictures only in the browser (P27), so native shows the chip alone.

export interface AttachmentThumbProps {
  locationId: string;
  /** The picture's Your data ref (`f_…`). */
  fileRef: string;
}

export const AttachmentThumb: (props: AttachmentThumbProps) => React.JSX.Element | null = () => null;
