import { useCallback, useState } from 'react';

import { hasCode } from '../errors';
import { useAction } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import type { MeResponse } from '../schemas';
import { TEAM_COPY } from '../team/copy';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { leaveOrg } from './api';
import { leaveBody, SETTINGS_READ_ONLY_ID } from './copy';

// Leave {org} (spec P18, F7): an outline button that asks first. POST /api/org/leave answers the new access in
// GET /api/me's shape (removed, by you), and applying it routes to No access (“You left {org}”), with the cached
// organization cleared. The only admin gets 409 last_admin, with the Team page's line and a way to Team.

export function LeaveSection(props: { org: string; admin: boolean }): React.JSX.Element {
  const { api, applyMe } = usePortal();
  const { readOnly } = useReadOnly();
  const { org } = props;
  const [open, setOpen] = useState(false);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [lastAdmin, setLastAdmin] = useState(false);

  const leave = useAction(useCallback(async () => {
    setDialogError(null);
    let answer: MeResponse;
    try {
      answer = await leaveOrg(api);
    } catch (error) {
      if (hasCode(error, 409, 'last_admin')) {
        setOpen(false);
        setLastAdmin(true);
      } else {
        setDialogError(error);
      }
      return;
    }
    setOpen(false);
    applyMe(answer);
  }, [api, applyMe]));

  function ask(): void {
    setLastAdmin(false);
    setDialogError(null);
    setOpen(true);
  }

  return (
    <Section kicker="Membership" title={`Leave ${org}`}>
      {lastAdmin ? (
        <Stack>
          <ErrorNotice message={TEAM_COPY.lastAdmin} />
          {props.admin ? <LinkButton href="/team" label="Go to Team" /> : null}
        </Stack>
      ) : null}
      <Actions>
        <Button
          variant="outline"
          label={`Leave ${org}`}
          onPress={ask}
          {...(readOnly ? { disabled: true, describedBy: SETTINGS_READ_ONLY_ID } : {})}
        />
      </Actions>
      <ConfirmDialog
        visible={open}
        title={`Leave ${org}?`}
        body={leaveBody(org)}
        confirmLabel="Leave"
        pendingLabel="Leaving…"
        pending={leave.pending}
        error={dialogError}
        onConfirm={() => { leave.run(); }}
        onCancel={() => { setOpen(false); }}
      />
    </Section>
  );
}
