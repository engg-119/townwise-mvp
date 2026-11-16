import { SetupEditor } from './SetupEditor';

// P31 Ordering setup on iOS and Android (/locations/[id]/orders/setup, members): suppliers, deliveries and items,
// edited and saved as on the web. The template, the sheet import, reading a file with TownwiseAI (D41) and the item
// sales upload read files, which is web only (a native file picker is a new dependency), so the page says to use a
// computer for those, naming TownwiseAI only while it is on. Setup.web.tsx adds them on the web.
export function Setup(): React.JSX.Element {
  return <SetupEditor />;
}
