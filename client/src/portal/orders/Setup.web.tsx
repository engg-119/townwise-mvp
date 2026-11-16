import { ItemSalesUpload } from './ItemSalesUpload.web';
import { SetupEditor } from './SetupEditor';
import { SetupRead } from './SetupRead.web';
import { SheetTools } from './SheetTools.web';

// P31 Ordering setup on the web (/locations/[id]/orders/setup, members): the shared editor (SetupEditor.tsx), plus
// what reads files in the browser: the template and the sheet import above the suppliers, then reading a file with
// TownwiseAI (D41) while it is on, and the item sales upload below the save. Setup.tsx is the native page.
export function Setup(): React.JSX.Element {
  return (
    <SetupEditor
      sheet={(slot) => <SheetTools {...slot} />}
      read={(slot) => <SetupRead {...slot} />}
      sales={(slot) => <ItemSalesUpload {...slot} />}
    />
  );
}
