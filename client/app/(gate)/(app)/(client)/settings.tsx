import { Placeholder } from '../../../../src/portal/shell/Page';
import { LinkButton } from '../../../../src/portal/ui/Button';

// P18 Settings (/settings, members): docs/portal/spec.md 16.3. Not built yet.
// Replace this file to build the page; src/portal/README.md lists the shared pieces. Until then it keeps the one
// way into two-step settings (/settings/security), which the dashboard linked to before the portal.
export default function SettingsPage(): React.JSX.Element {
  return (
    <Placeholder title="Settings">
      <LinkButton href="/settings/security" label="Two-factor settings" />
    </Placeholder>
  );
}
