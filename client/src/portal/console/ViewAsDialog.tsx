import { useCallback, useState } from 'react';

import { ApiError } from '../../api/client';
import { hasCode } from '../errors';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { FormField } from '../ui/FormField';
import { lookupPerson, startViewAs } from './api';
import { Dialog } from './Dialog';
import { problemOf } from './problems';

// C1, View as (spec 16.4, F8, Section 8): a reason of 5 to 200 characters, then POST /api/admin/view-as. The
// answer is the target's access with `viewAs` set; the portal layout then routes to the target's own page under
// the banner. A team row has no kit user id (MemberView), so the dialog finds it by exact email first.

export interface ViewAsTarget {
  email: string;
  /** Null for a team row: found by email on Start viewing. */
  userId: string | null;
  /** The organization whose admins see the view; null for a target with none. */
  orgName: string | null;
}

export const REASON_COPY = 'Enter a reason, 5 to 200 characters.';

const GONE = new ApiError('http', 'This person no longer exists.', { status: 404, code: 'not_found' });

function refusal(error: unknown): string | null {
  if (hasCode(error, 400, 'invalid_target')) return 'Staff accounts can’t be viewed as.';
  if (hasCode(error, 404, 'not_found')) return 'This person no longer exists.';
  return null;
}

export function viewAsBody(target: ViewAsTarget): string {
  const { email, orgName } = target;
  const admins = orgName === null ? '' : `, and ${orgName}’s admins can see it`;
  return `You’ll see what ${email} sees, read-only, for 30 minutes. This is recorded in the audit log with your reason${admins}. It ends early if ${email} joins, leaves or changes organization.`;
}

export function ViewAsDialog(props: { target: ViewAsTarget; onClose: () => void }): React.JSX.Element {
  const { target } = props;
  const { api, applyMe } = usePortal();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const start = useAction(useCallback(async (text: string) => {
    let userId = target.userId;
    if (userId === null) {
      userId = (await lookupPerson(api, target.email))?.userId ?? null;
      if (userId === null) throw GONE;
    }
    applyMe(await startViewAs(api, userId, text));
  }, [api, applyMe, target]));

  function submit(): void {
    const text = reason.trim();
    if (text.length < 5 || text.length > 200) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    start.run(text);
  }

  return (
    <Dialog
      title="View Townwise as"
      titleEmail={target.email}
      body={viewAsBody(target)}
      confirmLabel="Start viewing"
      pending={start.pending}
      problem={problemOf(start.error, refusal)}
      onConfirm={submit}
      onCancel={props.onClose}
    >
      <FormField
        label="Reason"
        helper="For example, the question you’re helping with."
        value={reason}
        onChangeText={setReason}
        onSubmitEditing={submit}
        autoCapitalize="sentences"
        maxLength={200}
        messages={invalid ? [REASON_COPY] : []}
      />
    </Dialog>
  );
}
