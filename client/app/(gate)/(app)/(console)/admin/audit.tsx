import { useCallback, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import type { ApiClient } from '../../../../../src/api/client';
import { fetchAudit, fetchOrgs, lookupPerson } from '../../../../../src/portal/console/api';
import { AuditTable } from '../../../../../src/portal/console/AuditTable';
import { EMAIL_COPY, isEmailAddress } from '../../../../../src/portal/console/email';
import type { AuditEvent, AuditPage } from '../../../../../src/portal/console/schemas';
import { AUDIT_ACTIONS } from '../../../../../src/portal/console/words';
import { errorCopy, hasCode } from '../../../../../src/portal/errors';
import { useAction, useBreakpoint, useLoad } from '../../../../../src/portal/hooks';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { AuditSkeleton } from '../../../../../src/portal/skeleton';
import {
  Actions, Button, EmptyState, ErrorNotice, FormField, Heading, LoadingLine, Panel, Select, Small, Stack,
} from '../../../../../src/portal/ui';

// P23. Audit log (/admin/audit, staff): docs/portal/spec.md 16.4, Section 9; the AdminAudit board. Newest first,
// filtered by organization (?orgId= from an organization's page), actor and action, and paged with Load more
// (`before`). The API filters by the actor's user id, so the actor's email is found by exact lookup first. Each
// row shows the server's plain-words summary and the action's allowlisted details, never a figure or note text.
// The organization filter's options are a read of their own; when it fails, the filters say so, with Try again.

interface Filters {
  orgId: string;
  actor: string;
  action: string;
}

const NONE: Filters = { orgId: '', actor: '', action: '' };

/** `actor`: no actor filter or one found, an address no one signed in with, or one the server refused (400). */
type Result = AuditPage & { actor: 'ok' | 'unknown' | 'invalid' };

async function loadAudit(api: ApiClient, filters: Filters, before?: string): Promise<Result> {
  let actorUserId: string | undefined;
  if (filters.actor !== '') {
    try {
      actorUserId = (await lookupPerson(api, filters.actor))?.userId ?? undefined;
    } catch (error) {
      if (hasCode(error, 400, 'invalid_request')) return { events: [], nextBefore: null, actor: 'invalid' };
      throw error;
    }
    if (actorUserId === undefined) return { events: [], nextBefore: null, actor: 'unknown' };
  }
  const page = await fetchAudit(api, { orgId: filters.orgId, actorUserId, action: filters.action, before });
  return { ...page, actor: 'ok' };
}

function filtered(filters: Filters): boolean {
  return filters.orgId !== '' || filters.actor !== '' || filters.action !== '';
}

export default function AuditLogPage(): React.JSX.Element {
  const { api } = usePortal();
  const { phone } = useBreakpoint();
  const params = useLocalSearchParams<{ orgId?: string }>();
  const [draft, setDraft] = useState<Filters>(() => ({ ...NONE, orgId: typeof params.orgId === 'string' ? params.orgId : '' }));
  const [applied, setApplied] = useState<Filters>(draft);
  const [actorInvalid, setActorInvalid] = useState(false);
  const [more, setMore] = useState<{ filters: Filters; events: AuditEvent[]; nextBefore: string | null } | null>(null);
  const orgs = useLoad(useCallback(() => fetchOrgs(api), [api]));
  const { state, reload } = useLoad(useCallback(() => loadAudit(api, applied), [api, applied]));

  const extra = more?.filters === applied ? more : null;
  // The last page loaded says whether there is another; null there means none, not “ask the first page”.
  const nextBefore = extra !== null ? extra.nextBefore : (state.status === 'ready' ? state.data.nextBefore : null);
  const loadMore = useAction(useCallback(async () => {
    if (nextBefore === null) return;
    const page = await loadAudit(api, applied, nextBefore);
    setMore((previous) => ({
      filters: applied,
      events: [...(previous?.filters === applied ? previous.events : []), ...page.events],
      nextBefore: page.nextBefore,
    }));
  }, [api, applied, nextBefore]));

  function apply(next: Filters): void {
    const actor = next.actor.trim();
    // Checked here first, so a typo never sends a lookup the server refuses.
    const invalid = actor !== '' && !isEmailAddress(actor);
    setActorInvalid(invalid);
    if (invalid) return;
    setMore(null);
    setApplied({ orgId: next.orgId, actor, action: next.action });
  }

  function clear(): void {
    setDraft(NONE);
    apply(NONE);
  }

  const orgItems = [
    { value: '', label: 'All organizations' },
    ...(orgs.state.status === 'ready' ? orgs.state.data.map((org) => ({ value: org.id, label: org.name })) : []),
  ];
  if (draft.orgId !== '' && !orgItems.some((item) => item.value === draft.orgId)) {
    orgItems.push({ value: draft.orgId, label: 'This organization' });
  }

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = <AuditSkeleton label="Loading the audit log" />;
  } else if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={reload} />;
  } else if (state.data.actor === 'invalid') {
    body = <EmptyState text={EMAIL_COPY}><Button variant="link" label="Clear filters" onPress={clear} /></EmptyState>;
  } else if (state.data.actor === 'unknown') {
    body = <EmptyState text="No one with that email has signed in."><Button variant="link" label="Clear filters" onPress={clear} /></EmptyState>;
  } else if (state.data.events.length === 0) {
    body = (
      <EmptyState text="Nothing recorded yet.">
        {filtered(applied) ? <Button variant="link" label="Clear filters" onPress={clear} /> : null}
      </EmptyState>
    );
  } else {
    const events = [...state.data.events, ...(extra?.events ?? [])];
    body = (
      <Stack gap={16}>
        <AuditTable label="Events" events={events} org={applied.orgId === ''} details />
        <Small>
          Staff actions are recorded before they take effect. When one then fails, its row says it didn’t take effect. Deleted people, organizations and locations read “deleted person”, “deleted organization” and “deleted location”.
        </Small>
        {loadMore.pending ? <LoadingLine text="Loading the audit log" minHeight={44} /> : null}
        {loadMore.error === null ? null : <ErrorNotice error={loadMore.error} onRetry={loadMore.run} />}
        {nextBefore === null || loadMore.pending ? null : <Actions><Button variant="outline" label="Load more" onPress={loadMore.run} /></Actions>}
      </Stack>
    );
  }

  return (
    <Page title="Audit log" lead="Every recorded action, newest first. Guest counts, sales figures, note text and request notes are never recorded here.">
      <Stack gap={32}>
        <Panel label="Filters">
          <Heading level={2}>Filters</Heading>
          <View style={phone ? styles.filtersStacked : styles.filters}>
            <View style={styles.filter}>
              <Select label="Organization" value={draft.orgId} onChange={(orgId) => { setDraft({ ...draft, orgId }); }} items={orgItems} />
            </View>
            <View style={styles.filter}>
              <FormField
                label="Actor email"
                value={draft.actor}
                onChangeText={(actor) => { setDraft({ ...draft, actor }); }}
                onSubmitEditing={() => { apply(draft); }}
                keyboardType="email-address"
                autoCorrect={false}
                maxLength={320}
                messages={actorInvalid ? [EMAIL_COPY] : []}
              />
            </View>
            <View style={styles.filter}>
              <Select
                label="Action"
                value={draft.action}
                onChange={(action) => { setDraft({ ...draft, action }); }}
                items={[{ value: '', label: 'All actions' }, ...AUDIT_ACTIONS]}
              />
            </View>
          </View>
          {orgs.state.status === 'failed' ? (
            <ErrorNotice message={`The organizations to filter by didn’t load. ${errorCopy(orgs.state.error)}`} onRetry={orgs.reload} />
          ) : null}
          <Actions>
            <Button variant="outline" label="Apply filters" onPress={() => { apply(draft); }} />
            <Button variant="link" label="Clear filters" onPress={clear} />
          </Actions>
        </Panel>
        {body}
      </Stack>
    </Page>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', columnGap: 20, alignItems: 'flex-start' },
  filtersStacked: { gap: 20 },
  filter: { flex: 1, minWidth: 0 },
});
