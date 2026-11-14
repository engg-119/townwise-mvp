import { BusinessRules } from '../../../../../../src/portal/rules/BusinessRules';

// P29 Business rules (/locations/[locationId]/rules, members): docs/portal/spec.md 16.3 and 10.16. The page lives in
// src/portal/rules/; it is the top bar's Rules section.
export default function RulesTab(): React.JSX.Element {
  return <BusinessRules />;
}
