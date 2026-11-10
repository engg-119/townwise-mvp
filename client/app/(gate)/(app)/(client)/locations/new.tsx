import { AddLocationForm } from '../../../../../src/portal/AddLocationForm';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { LinkButton } from '../../../../../src/portal/ui/Button';
import { Columns, Stack } from '../../../../../src/portal/ui/layout';

// P10 Add location (/locations/new, org admins; the route guard sends members to Locations): docs/portal/spec.md
// 16.3. AddLocationForm (its header says how the places checklist and Name and Town add locations), and Cancel
// back to Locations. Under view-as the form is read-only (AddLocationForm).
export default function AddLocationPage(): React.JSX.Element {
  const { me } = usePortal();
  const orgName = me.access.state === 'member' ? me.access.org.name : '';
  return (
    <Page eyebrow={orgName} title="Add location">
      <Columns
        main={(
          <Stack gap={12}>
            <AddLocationForm />
            <LinkButton href="/dashboard" label="Cancel" />
          </Stack>
        )}
      />
    </Page>
  );
}
