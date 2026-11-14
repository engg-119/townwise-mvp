// The TownwiseAI page's drop overlay (spec P25, D36) is web only: native has no drag and drop and no uploads (D20), so
// this draws nothing. ChatDrop.web.tsx is the overlay.

export interface ChatDropProps {
  /** Why files can't be attached now (view-as, stored files off, the budget spent, still loading); null when they can. */
  blocked: string | null;
  /** The files dropped on the page, when they can be attached. */
  onFiles: (files: File[]) => void;
  /** A drop that couldn't attach anything: the page shows `blocked` as an alert. */
  onRefused?: () => void;
}

export const ChatDrop: (props: ChatDropProps) => React.JSX.Element | null = () => null;
