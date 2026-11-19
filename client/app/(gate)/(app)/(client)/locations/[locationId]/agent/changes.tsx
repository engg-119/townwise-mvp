import { ChangesPage } from '../../../../../../../src/chat/ui/ChangesPage';

// TownwiseAI's log (/locations/[locationId]/agent/changes, members; D59): every change it saved here on its own, with
// Undo. Rendered inside the location layout, which draws the header and tabs above it; the page is src/chat/ui.
export default function AgentChanges(): React.JSX.Element {
  return <ChangesPage />;
}
