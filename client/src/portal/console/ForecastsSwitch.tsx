import { useCallback, useState } from 'react';

import { formatDate } from '../format';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { switchForecasts, type ForecastsState } from './calibrations';
import { Dialog } from './Dialog';
import { problemOf } from './problems';
import type { StaffOrg } from './schemas';

// The organization's forecasts switch (G1): while it is off nothing is published, by staff or by a calibration.
// Forecasts are on by default for an organization nobody switched (D42, owner directive 2026-11-16): it shows "On
// (default)". Switching on needs the staff member's word that the owner agreed to see forecasts and to their going to
// Anthropic through TownwiseAI; the organization's admins see either change in their Townwise staff activity.

const ACTIVITY = 'Its admins see this in their Townwise staff activity.';

function SwitchDialog(props: { org: StaffOrg; turnOn: boolean; onDone: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { org, turnOn } = props;
  const { api } = usePortal();
  const [agreed, setAgreed] = useState(false);
  const act = useAction(useCallback(async () => {
    await switchForecasts(api, org.id, turnOn);
    await props.onDone();
  }, [api, org.id, turnOn, props]));
  return (
    <Dialog
      title={turnOn ? `Switch on forecasts for ${org.name}?` : `Switch off forecasts for ${org.name}?`}
      body={turnOn
        ? `Owners and TownwiseAI will see forecasts you publish, and calibrations that pass every check will publish themselves. Switch on only once ${org.name}’s owner has agreed to see forecasts and to their being sent to Anthropic through TownwiseAI. ${ACTIVITY}`
        : `Nothing more is published until they’re back on; passing calibrations stay drafts. Forecasts already published stay until you withdraw them. ${ACTIVITY}`}
      confirmLabel={turnOn ? 'Switch on' : 'Switch off'}
      pendingLabel={turnOn ? 'Switching on…' : 'Switching off…'}
      pending={act.pending}
      confirmDisabled={turnOn && !agreed}
      problem={problemOf(act.error)}
      onConfirm={act.run}
      onCancel={props.onClose}
    >
      {turnOn ? <Checkbox label={`${org.name}’s owner agreed`} checked={agreed} disabled={act.pending} onChange={setAgreed} /> : null}
    </Dialog>
  );
}

export function ForecastsSwitch(props: { org: StaffOrg; forecasts: ForecastsState; onChanged: () => Promise<void> }): React.JSX.Element {
  const { org, forecasts, onChanged } = props;
  const [open, setOpen] = useState(false);
  const done = useCallback(async () => {
    setOpen(false);
    await onChanged();
  }, [onChanged]);
  const on = forecasts.on;
  return (
    <Stack gap={12}>
      <Small>
        {on && forecasts.at !== null
          ? `Forecasts are on for ${org.name} since ${formatDate(forecasts.at)}.`
          : on
            ? `On (default). Forecasts are on for ${org.name}, as for every organization Townwise staff haven’t switched off.`
            : `Forecasts are off for ${org.name}. Nothing is published, by you or by a calibration, until they’re on.`}
      </Small>
      <Button variant={on ? 'outline' : 'primary'} label={on ? 'Switch off' : 'Switch on'} onPress={() => { setOpen(true); }} />
      {open ? <SwitchDialog org={org} turnOn={!on} onDone={done} onClose={() => { setOpen(false); }} /> : null}
    </Stack>
  );
}
