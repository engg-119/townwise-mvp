import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { errorCopy, hasCode } from '../errors';
import { plural } from '../format';
import { useLoad } from '../hooks';
import { formatRange } from '../locations/dates';
import { LoadFailure, Loading } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, Messages, Notice, ReadOnlyLine } from '../ui/feedback';
import { Section } from '../ui/layout';
import { Lead, Small } from '../ui/text';
import { deleteItemSales, fetchOrderSetup, saveOrderSetup, type OrderSetup, type OrderSetupAnswer } from './api';
import { pruneMarks, withMarks, type ProposalImport, type SetupMarks } from './proposal';
import {
  checkDraft, draftOf, fieldId, newItem, newSupplier, normalizeName, SETUP_LIMITS, type ItemDraft, type SetupDraft, type SetupProblems,
  type SupplierDraft,
} from './setupDraft';
import { itemHasHistory, ItemPanel, SupplierPanel } from './SetupRows';

// P31 Ordering setup (/locations/[id]/orders/setup, members; design Decisions 3, 4 and 8; the order-setup and
// item-sales specs): the location's suppliers with their deliveries, its items, and the item sales coverage, read with
// GET .../orders/setup and saved whole with PUT over the version it loaded. Someone else's save in between answers
// 409 `setup_changed`: the page says so and offers their changes, which replace the draft after a confirm. Shared by
// both platforms; the web adds the template, the sheet import, reading a file with TownwiseAI (D41, only while the
// GET's `canReadWithAi` holds) and the item sales upload through the slots (Setup.web.tsx). Removing an item with
// history (item sales, counts, saved edits or rules, as the GET's `itemsWithHistory` names them) asks first, in the
// page. Under view-as every field and write is disabled in place, described by the read-only line. A read's marks
// (an estimated servings value, a name not in the file) replace their field's helper until the field changes or a
// save goes through.

const READ_ONLY_ID = 'setup-ro';

type Status = Pick<OrderSetupAnswer, 'today' | 'coverage' | 'itemCoverage' | 'counts' | 'itemsWithHistory' | 'canReadWithAi'>;

/** What the sheet tools (web) work on: the draft, before anything saves. */
export interface SheetSlot {
  readonly draft: SetupDraft;
  readonly setDraft: (next: SetupDraft) => void;
  readonly locked: boolean;
  readonly readOnlyId: string | null;
}

/** What reading with TownwiseAI (web, D41) works on: the draft its suggestions merge into, before anything saves. */
export interface ReadSlot {
  readonly draft: SetupDraft;
  /** Puts a read's merge in the draft, with its marks. */
  readonly apply: (result: ProposalImport) => void;
  readonly locked: boolean;
  readonly readOnlyId: string | null;
}

/** What the item sales upload (web) works on: the saved setup, whose ids it sends, and the draft it adds names to. */
export interface SalesSlot {
  readonly saved: OrderSetup | null;
  readonly items: readonly ItemDraft[];
  /** The draft differs from the saved setup. */
  readonly dirty: boolean;
  /** The town's today (GET .../orders/setup): uploads end the day before it. */
  readonly today: string;
  /** Adds a point-of-sale name to an item of the draft; why it can't, or null once it is added. */
  readonly addPosName: (itemKey: string, name: string) => string | null;
  /** Reads the coverage and per-item status again, after an upload. */
  readonly onUploaded: () => void;
  /** The server's setup no longer has an item the saved one has (400 `unknown_item`): someone else saved it. */
  readonly onSetupChanged: () => void;
  readonly readOnly: boolean;
  readonly readOnlyId: string | null;
}

export function SetupEditor(props: {
  sheet?: (slot: SheetSlot) => React.ReactNode;
  read?: (slot: ReadSlot) => React.ReactNode;
  sales?: (slot: SalesSlot) => React.ReactNode;
}): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const load = useCallback(() => fetchOrderSetup(api, location.id), [api, location.id]);
  const answer = useLoad(load);
  if (answer.state.status === 'loading') return <Loading text={`Loading the ordering setup for ${location.name}`} />;
  if (answer.state.status === 'failed') return <LoadFailure error={answer.state.error} onRetry={answer.reload} />;
  return <Editor initial={answer.state.data} {...props} />;
}

function saveFailure(error: unknown): string {
  if (error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && error.status === 429))) {
    return errorCopy(error);
  }
  if (hasCode(error, 400, 'invalid_request')) return 'Townwise couldn’t save this setup. Reload the page and try again.';
  return 'The setup didn’t save. Try again.';
}

function Editor(props: {
  initial: OrderSetupAnswer;
  sheet?: (slot: SheetSlot) => React.ReactNode;
  read?: (slot: ReadSlot) => React.ReactNode;
  sales?: (slot: SalesSlot) => React.ReactNode;
}): React.JSX.Element {
  const { api } = usePortal();
  const { location, org } = useLocation();
  const { readOnly, line: readOnlyLine } = useReadOnly();
  const [saved, setSaved] = useState<OrderSetup | null>(props.initial.setup);
  const [status, setStatus] = useState<Status>(props.initial);
  const [draft, setDraft] = useState<SetupDraft>(() => draftOf(props.initial.setup));
  const [problems, setProblems] = useState<SetupProblems>({});
  const [problemCount, setProblemCount] = useState(0);
  const [marks, setMarks] = useState<SetupMarks>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'reload' | 'delete' | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<unknown>(null);
  /** The key of an item with history that Remove this item asked about. */
  const [removing, setRemoving] = useState<string | null>(null);
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const locked = readOnly || saving;
  const lock = { locked, readOnlyId };
  const described = readOnlyId === null ? {} : { describedBy: readOnlyId };
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(saved)), [draft, saved]);

  const edit = (next: SetupDraft): void => {
    setDraft(next);
    setNotice(null);
    setMarks((current) => pruneMarks(current, next));
  };
  const applyRead = (result: ProposalImport): void => {
    edit(result.draft);
    setMarks((current) => withMarks(current, result.marks));
  };
  const setSupplier = (key: string, next: SupplierDraft): void => {
    edit({ ...draft, suppliers: draft.suppliers.map((supplier) => (supplier.key === key ? next : supplier)) });
  };
  const removeSupplier = (key: string): void => {
    edit({
      suppliers: draft.suppliers.filter((supplier) => supplier.key !== key),
      items: draft.items.map((item) => (item.supplierKey === key ? { ...item, supplierKey: '' } : item)),
    });
  };
  const setItem = (key: string, next: ItemDraft): void => {
    edit({ ...draft, items: draft.items.map((item) => (item.key === key ? next : item)) });
  };
  const removeItem = (key: string): void => {
    edit({ ...draft, items: draft.items.filter((item) => item.key !== key) });
  };

  function addPosName(itemKey: string, name: string): string | null {
    const item = draft.items.find((candidate) => candidate.key === itemKey);
    if (item === undefined) return 'That item is no longer in the setup.';
    if (item.posNames.some((pos) => normalizeName(pos.name) === normalizeName(name))) return `${item.name} already lists that name.`;
    if (item.posNames.length >= SETUP_LIMITS.posNames) return `${item.name} already has 10 point-of-sale names.`;
    setItem(itemKey, { ...item, posNames: [...item.posNames, { name, perSale: '1' }] });
    return null;
  }

  async function save(): Promise<void> {
    const check = checkDraft(draft);
    setSaveError(null);
    setNotice(null);
    if (!check.ok) {
      setProblems(check.problems);
      setProblemCount(check.count);
      return;
    }
    setProblems({});
    setProblemCount(0);
    setSaving(true);
    try {
      const stored = await saveOrderSetup(api, location.id, saved?.version ?? 0, check.input);
      setSaved(stored);
      setDraft(draftOf(stored));
      setMarks({});
      setConflict(false);
      setNotice('Saved the ordering setup.');
    } catch (caught) {
      if (hasCode(caught, 409, 'setup_changed')) setConflict(true);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function refreshStatus(): Promise<void> {
    try {
      const fresh = await fetchOrderSetup(api, location.id);
      setStatus(fresh);
    } catch {
      // The coverage line keeps its last value; the upload's own result says what saved.
    }
  }

  async function runConfirm(): Promise<void> {
    setConfirmPending(true);
    setConfirmError(null);
    try {
      if (confirm === 'reload') {
        const fresh = await fetchOrderSetup(api, location.id);
        setSaved(fresh.setup);
        setStatus(fresh);
        setDraft(draftOf(fresh.setup));
        setMarks({});
        setProblems({});
        setProblemCount(0);
        setConflict(false);
        setNotice('Loaded the setup as it was last saved.');
      } else {
        const { removed } = await deleteItemSales(api, location.id);
        await refreshStatus();
        setNotice(`Deleted ${plural(removed, 'day', 'days')} of item sales.`);
      }
      setConfirm(null);
    } catch (caught) {
      setConfirmError(caught);
    } finally {
      setConfirmPending(false);
    }
  }

  const { coverage } = status;
  const removingItem = removing === null ? undefined : draft.items.find((item) => item.key === removing);
  const topMessages = [
    ...(problems[fieldId.setup] ?? []),
    ...(problemCount > 0 ? [`Fix the ${plural(problemCount, 'marked field', 'marked fields')} before saving.`] : []),
  ];
  const singleSupplier = draft.suppliers.length === 1 ? (draft.suppliers[0]?.key ?? '') : '';
  return (
    <View style={styles.page}>
      {readOnly ? <ReadOnlyLine text={readOnlyLine} nativeID={READ_ONLY_ID} /> : null}
      {notice === null ? null : <Notice text={notice} />}
      <Lead>
        How Townwise builds {location.name}’s orders: each supplier and when it delivers, the items you order from them,
        and what your point-of-sale system calls each item.
      </Lead>
      <View style={styles.stack}>
        <Small white>
          {coverage === null
            ? 'No item sales yet.'
            : `Item sales cover ${formatRange(coverage.firstDate, coverage.lastDate)}, ${plural(coverage.dayCount, 'day', 'days')} in all.`}
        </Small>
        {dirty ? <Small white>You have unsaved changes. Save the setup below.</Small> : null}
        {coverage !== null && org.role === 'org_admin' ? (
          <Actions>
            <Button variant="outline" label="Delete item sales" disabled={readOnly} {...described} onPress={() => { setConfirmError(null); setConfirm('delete'); }} />
          </Actions>
        ) : null}
      </View>
      {props.sheet === undefined
        ? <Small>Use a computer to download the template, import a sheet or upload item sales.</Small>
        : props.sheet({ draft, setDraft: edit, locked, readOnlyId })}
      {status.canReadWithAi && props.read !== undefined
        ? props.read({ draft, apply: applyRead, locked, readOnlyId })
        : null}

      <Section title="Suppliers">
        {draft.suppliers.length === 0 ? <Small>No suppliers yet. Add each one you order from, with its delivery days.</Small> : null}
        {draft.suppliers.map((supplier, index) => (
          <SupplierPanel
            key={supplier.key}
            supplier={supplier}
            index={index}
            problems={problems}
            lock={lock}
            onChange={(next) => { setSupplier(supplier.key, next); }}
            onRemove={() => { removeSupplier(supplier.key); }}
          />
        ))}
        <Actions>
          <Button
            variant="outline"
            label="Add a supplier"
            disabled={locked || draft.suppliers.length >= SETUP_LIMITS.suppliers}
            {...described}
            onPress={() => { edit({ ...draft, suppliers: [...draft.suppliers, newSupplier()] }); }}
          />
        </Actions>
      </Section>

      <Section title="Items">
        {draft.items.length === 0 ? <Small>No items yet. Add each item you order.</Small> : null}
        {draft.items.map((item, index) => (
          <ItemPanel
            key={item.key}
            item={item}
            index={index}
            suppliers={draft.suppliers}
            problems={problems}
            status={status}
            mark={marks[item.key]}
            lock={lock}
            onChange={(next) => { setItem(item.key, next); }}
            onRemove={() => { if (itemHasHistory(item, status)) setRemoving(item.key); else removeItem(item.key); }}
          />
        ))}
        <Actions>
          <Button
            variant="outline"
            label="Add an item"
            disabled={locked || draft.items.length >= SETUP_LIMITS.items}
            {...described}
            onPress={() => { edit({ ...draft, items: [...draft.items, newItem(singleSupplier)] }); }}
          />
        </Actions>
      </Section>

      <View style={styles.stack}>
        {topMessages.length === 0 ? null : <Messages live="alert" items={topMessages} />}
        {conflict ? (
          <View style={styles.stack}>
            <Messages
              live="alert"
              items={['Someone else changed this setup since you opened it. Load their changes to see them; your unsaved changes here will be lost.']}
            />
            <Actions>
              <Button variant="outline" label="Load their changes" onPress={() => { setConfirmError(null); setConfirm('reload'); }} />
            </Actions>
          </View>
        ) : null}
        {saveError === null ? null : <ErrorNotice message={saveFailure(saveError)} />}
        <Actions>
          <Button variant="primary" label={saving ? 'Saving…' : 'Save the setup'} disabled={locked} {...described} onPress={() => { void save(); }} />
          <Small>{dirty ? 'Unsaved changes.' : 'No unsaved changes.'}</Small>
        </Actions>
      </View>

      {props.sales?.({
        saved, items: draft.items, dirty, today: status.today, addPosName, onUploaded: () => { void refreshStatus(); },
        onSetupChanged: () => { setConflict(true); }, readOnly, readOnlyId,
      }) ?? null}

      <Actions>
        <LinkButton href={locationHref(location.id, 'orders')} label="Back to Orders" />
      </Actions>

      <ConfirmDialog
        visible={confirm !== null}
        title={confirm === 'reload' ? 'Load their changes' : 'Delete item sales'}
        body={confirm === 'reload'
          ? 'This replaces your unsaved changes here with the setup as it was last saved.'
          : `This deletes ${plural(coverage?.dayCount ?? 0, 'day', 'days')} of item sales for ${location.name}. The setup and counts stay. This can’t be undone.`}
        confirmLabel={confirm === 'reload' ? 'Load their changes' : 'Delete item sales'}
        pendingLabel={confirm === 'reload' ? 'Loading…' : 'Deleting…'}
        pending={confirmPending}
        error={confirmError}
        onConfirm={() => { void runConfirm(); }}
        onCancel={() => { setConfirm(null); }}
      />
      <ConfirmDialog
        visible={removingItem !== undefined}
        title="Remove this item"
        body={`${removingItem?.name.trim() ?? 'This item'} has item sales, counts, saved edits or rules. They stay with it only while it is in the setup: once the setup is saved without it, they no longer count toward any order, and adding it again later starts it with none. Nothing changes until you save.`}
        confirmLabel="Remove the item"
        onConfirm={() => {
          if (removing !== null) removeItem(removing);
          setRemoving(null);
        }}
        onCancel={() => { setRemoving(null); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: theme.space[6] },
  stack: { gap: theme.space[3] },
});
