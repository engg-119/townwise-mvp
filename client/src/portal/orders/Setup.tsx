import { SetupEditor } from './SetupEditor';
import { SetupRead } from './SetupRead';

// P31 Ordering setup on iOS and Android (/locations/[id]/orders/setup, members): suppliers, deliveries and items,
// edited and saved as on the web, and reading a file or pasted text with TownwiseAI (D41) while it is on, through the
// system file picker (SetupRead.tsx). The template, the sheet import and the item sales upload read files in the
// browser, which is web only, so the page says to use a computer for those. Setup.web.tsx adds them on the web.
export function Setup(): React.JSX.Element {
  return <SetupEditor read={(slot) => <SetupRead {...slot} />} />;
}
