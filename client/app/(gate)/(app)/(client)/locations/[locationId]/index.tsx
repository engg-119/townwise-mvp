import { Home } from '../../../../../../src/portal/home/Home';

// P11 Home (/locations/[locationId], members; the location's first page): docs/portal/spec.md 16.3. The page lives
// in src/portal/home/; it reads and writes nothing of its own, so view-as shows it unchanged. Rendered inside the
// location layout, which draws the header and the switcher.
export default function HomeTab(): React.JSX.Element {
  return <Home />;
}
