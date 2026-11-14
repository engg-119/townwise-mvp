import { SetupEditor } from './SetupEditor';
import { SheetTools } from './SheetTools.web';

// P31 Ordering setup on the web (/locations/[id]/orders/setup, members): the shared editor (SetupEditor.tsx), plus
// what reads files in the browser: the template and the sheet import above the suppliers. Setup.tsx is the native page.
export function Setup(): React.JSX.Element {
  return <SetupEditor sheet={(slot) => <SheetTools {...slot} />} />;
}
