import { Button } from '../ui/Button';

// The drop step's browser pieces on native: uploads are web only (D20), so there is no drop and no picker; the
// step says where to drop files instead (HistoryStepDrop.web.tsx is the web version).

export function DropArea(props: {
  enabled: boolean;
  onFiles: (files: File[]) => void;
  onOver: (count: number | null) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return <>{props.children}</>;
}

/** Never shown on native (CAN_DROP is false); kept so the step has one shape on both platforms. */
export function FilePicker(props: {
  enabled: boolean;
  label: string;
  onFiles: (files: File[]) => void;
  describedBy?: string;
}): React.JSX.Element {
  return <Button variant="outline" label={props.label} disabled />;
}

export const CAN_DROP = false as boolean;
