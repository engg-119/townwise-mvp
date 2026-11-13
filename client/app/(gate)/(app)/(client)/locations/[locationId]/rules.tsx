import { BusinessRules } from '../../../../../../src/portal/rules/BusinessRules';

// P28 Business rules (/locations/[locationId]/rules, members): docs/portal/spec.md 16.3 and 10.16. The page lives in
// src/portal/rules/; the top bar marks TownwiseAI on it.
export default function RulesTab(): React.JSX.Element {
  return <BusinessRules />;
}
