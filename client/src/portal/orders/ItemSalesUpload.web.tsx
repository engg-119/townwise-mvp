import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { errorCopy, hasCode } from '../errors';
import { plural } from '../format';
import { formatRange, localToday } from '../locations/dates';
import { usePortal } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button } from '../ui/Button';
import { LoadingLine, Messages, Notice } from '../ui/feedback';
import { Section } from '../ui/layout';
import { Select } from '../ui/Select';
import { Small } from '../ui/text';
import { uploadItemSales, type ItemSalesChunk } from './api';
import {
  chunksOf, ColumnSampler, proposeColumns, SalesMatcher, type ColumnProfile, type MatchOutcome, type PresetName, type SalesColumns,
} from './itemSales';
import type { SalesSlot } from './SetupEditor';
import { SETUP_LIMITS } from './setupDraft';
import { readSheetFile, SHEET_ACCEPT } from './sheetFile.web';

// Item sales on the Ordering setup page (web; design Decision 4, the item-sales spec): choose a point-of-sale item
// export (CSV or Excel), check the proposed date, item and quantity columns, see what matched the saved setup's
// point-of-sale names, add unmatched names to items, and send. The browser reads the file again for each step and
// keeps no cell but the unmatched names, which stay on this page. Only item ids, dates and servings are sent, in spans
// of at most 31 days, in order; a failure stops and says which dates did not save, and sending again resends them (the
// server replaces whole days, so a resend is safe). Under view-as the file control is disabled in place.

/** Unmatched names listed with "Add to an item", most rows first. */
const SHOWN_NAMES = 100;

/** A file matched with these columns against the saved setup at `version`. */
interface Matched { columns: ColumnProfile[]; choice: SalesColumns; outcome: MatchOutcome; version: number }

type Step =
  | { kind: 'choose' }
  | { kind: 'reading' }
  | { kind: 'columns'; columns: ColumnProfile[]; preset: PresetName | null; choice: SalesColumns }
  | { kind: 'no_dates' }
  | ({ kind: 'preview' } & Matched)
  | { kind: 'sending'; at: number; of: number }
  | { kind: 'failed'; matched: Matched; chunks: ItemSalesChunk[]; index: number; error: unknown }
  | { kind: 'done'; days: number; from: string; to: string };

function columnOptions(columns: readonly ColumnProfile[]): { value: string; label: string }[] {
  return columns.map((column, index) => ({ value: String(index), label: column.name === '' ? `Column ${String(index + 1)}` : column.name }));
}

function chosen(choice: SalesColumns): { date: number; item: number; quantity: number } | null {
  const { date, item, quantity } = choice;
  if (date === null || item === null || quantity === null || new Set([date, item, quantity]).size !== 3) return null;
  return { date, item, quantity };
}

function failureReason(error: unknown): string {
  if (hasCode(error, 400, 'unknown_item')) return 'An item is no longer in the saved setup. Match the file again, then send.';
  return errorCopy(error);
}

export function ItemSalesUpload(props: SalesSlot): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const input = useRef<HTMLInputElement | null>(null);
  const file = useRef<File | null>(null);
  const run = useRef(0);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<Readonly<Record<string, string>>>({});
  const { saved } = props;
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };

  useEffect(() => () => { run.current += 1; file.current = null; }, []);

  function restart(): void {
    run.current += 1;
    file.current = null;
    setProblem(null);
    setAdded({});
    setStep({ kind: 'choose' });
  }

  async function open(chosenFile: File): Promise<void> {
    restart();
    const mine = run.current;
    setStep({ kind: 'reading' });
    const found: { sampler: ColumnSampler | null } = { sampler: null };
    const outcome = await readSheetFile(chosenFile, {
      header: (cells) => { found.sampler = new ColumnSampler(cells); },
      row: (cells) => { found.sampler?.add(cells); },
    }, () => run.current !== mine);
    if (outcome === 'cancelled' || run.current !== mine) return;
    const finished = found.sampler?.finish() ?? null;
    if (outcome !== 'done' || finished === null) {
      setProblem(outcome === 'done' ? 'That file has no rows.' : outcome.problem);
      setStep({ kind: 'choose' });
      return;
    }
    const proposal = proposeColumns(finished);
    if (proposal.columns.date === null) {
      setStep({ kind: 'no_dates' });
      return;
    }
    file.current = chosenFile;
    setStep({ kind: 'columns', columns: finished, preset: proposal.preset, choice: proposal.columns });
  }

  async function match(columns: ColumnProfile[], choice: SalesColumns): Promise<void> {
    const picked = chosen(choice);
    const current = file.current;
    if (picked === null || current === null || saved === null) return;
    run.current += 1;
    const mine = run.current;
    setStep({ kind: 'reading' });
    const matcher = new SalesMatcher(picked, saved.items, localToday());
    const outcome = await readSheetFile(current, { header: () => undefined, row: (cells) => { matcher.add(cells); } }, () => run.current !== mine);
    if (outcome === 'cancelled' || run.current !== mine) return;
    if (outcome !== 'done') {
      restart();
      setProblem(outcome.problem);
      return;
    }
    setAdded({});
    setStep({ kind: 'preview', columns, choice, outcome: matcher.finish(), version: saved.version });
  }

  async function send(matched: Matched, chunks: ItemSalesChunk[], start: number): Promise<void> {
    const { outcome } = matched;
    if (props.readOnly || outcome.firstDate === null || outcome.lastDate === null) return;
    const mine = run.current;
    for (let index = start; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      setStep({ kind: 'sending', at: index + 1, of: chunks.length });
      try {
        await uploadItemSales(api, location.id, chunk);
      } catch (error) {
        if (run.current === mine) setStep({ kind: 'failed', matched, chunks, index, error });
        if (index > start) props.onUploaded();
        return;
      }
      if (run.current !== mine) return;
    }
    file.current = null;
    setStep({ kind: 'done', days: outcome.days.length, from: outcome.firstDate, to: outcome.lastDate });
    props.onUploaded();
  }

  function addName(name: string, itemKey: string): void {
    const why = props.addPosName(itemKey, name);
    const item = props.items.find((candidate) => candidate.key === itemKey);
    setAdded((now) => ({ ...now, [name]: why ?? `Added to ${item?.name.trim() ?? 'that item'}. Save the setup, then match the file again.` }));
  }

  if (saved === null || saved.items.length === 0) {
    return (
      <Section title="Item sales">
        <Small>Save the setup with its items and their point-of-sale names first. Then upload item sales here.</Small>
      </Section>
    );
  }

  const fileControl = (
    <>
      {props.readOnly ? null : (
        <input
          ref={input}
          type="file"
          accept={SHEET_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          data-testid="item-sales-file"
          style={{ display: 'none' }}
          onChange={(event) => {
            const picked = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (picked !== undefined) void open(picked);
          }}
        />
      )}
      <Button
        variant="outline"
        label={step.kind === 'choose' ? 'Choose an item sales file' : 'Choose another file'}
        disabled={props.readOnly || step.kind === 'reading' || step.kind === 'sending'}
        {...described}
        onPress={() => { input.current?.click(); }}
      />
    </>
  );

  return (
    <Section title="Item sales">
      <Small>
        Upload an item sales export from your point-of-sale system, such as Toast’s Product Mix or Square’s item sales, as a
        CSV or Excel file, with one row per day or per sale. Your browser reads it and matches each item name to the
        point-of-sale names above. Only item ids, dates and servings are sent: never the file, its item names or anything
        else in it. Sending replaces the item sales stored for those dates.
      </Small>
      {problem === null ? null : <Messages live="alert" items={[problem]} />}
      {step.kind === 'reading' ? <LoadingLine text="Reading the file…" minHeight={44} /> : null}
      {step.kind === 'sending' ? <LoadingLine text={`Sending part ${String(step.at)} of ${String(step.of)}…`} minHeight={44} /> : null}
      {step.kind === 'no_dates' ? (
        <Messages live="alert" items={['This file has no column of dates. The export needs one row per day or per sale, with its date.']} />
      ) : null}
      {step.kind === 'done' ? (
        <Notice text={`Saved item sales for ${plural(step.days, 'day', 'days')}, ${formatRange(step.from, step.to)}.`} />
      ) : null}
      {step.kind === 'columns' ? (
        <ColumnStep
          step={step}
          readOnly={props.readOnly}
          onChange={(choice) => { setStep({ ...step, choice }); }}
          onMatch={() => { void match(step.columns, step.choice); }}
        />
      ) : null}
      {step.kind === 'preview' ? (
        <Preview
          outcome={step.outcome}
          stale={step.version !== saved.version}
          dirty={props.dirty}
          items={props.items}
          added={added}
          readOnly={props.readOnly}
          readOnlyId={props.readOnlyId}
          onAdd={addName}
          onMatchAgain={() => { void match(step.columns, step.choice); }}
          onSend={() => {
            const { outcome } = step;
            if (outcome.firstDate === null || outcome.lastDate === null) return;
            void send(step, chunksOf(outcome.days, outcome.firstDate, outcome.lastDate), 0);
          }}
        />
      ) : null}
      {step.kind === 'failed' ? (
        <View style={styles.stack}>
          <Messages
            live="alert"
            items={[
              ...(step.index > 0 ? [`Saved ${formatRange(step.chunks[0]?.from ?? '', step.chunks[step.index - 1]?.to ?? '')}.`] : []),
              `${formatRange(step.chunks[step.index]?.from ?? '', step.matched.outcome.lastDate ?? '')} didn’t save. ${failureReason(step.error)}`,
            ]}
          />
          <Actions>
            {hasCode(step.error, 400, 'unknown_item') ? null : (
              <Button
                variant="outline"
                label="Send the rest again"
                disabled={props.readOnly || step.matched.version !== saved.version}
                {...described}
                onPress={() => { void send(step.matched, step.chunks, step.index); }}
              />
            )}
            <Button
              variant="link"
              label="Match again"
              disabled={props.readOnly}
              {...described}
              onPress={() => { void match(step.matched.columns, step.matched.choice); }}
            />
          </Actions>
        </View>
      ) : null}
      <Actions>{fileControl}</Actions>
    </Section>
  );
}

function ColumnStep(props: {
  step: Extract<Step, { kind: 'columns' }>;
  readOnly: boolean;
  onChange: (choice: SalesColumns) => void;
  onMatch: () => void;
}): React.JSX.Element {
  const { step } = props;
  const options = columnOptions(step.columns);
  const ready = chosen(step.choice) !== null;
  const set = (key: keyof SalesColumns) => (value: string): void => {
    props.onChange({ ...step.choice, [key]: value === '' ? null : Number(value) });
  };
  const value = (index: number | null): string => (index === null ? '' : String(index));
  return (
    <View style={styles.stack}>
      <Small white>
        {step.preset === null ? 'Townwise guessed these columns. Check them, then match.' : `These columns match a ${step.preset} export. Check them, then match.`}
      </Small>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Select label="Date column" placeholder="Choose a column" items={options} value={value(step.choice.date)} onChange={set('date')} />
        </View>
        <View style={styles.cell}>
          <Select label="Item name column" placeholder="Choose a column" items={options} value={value(step.choice.item)} onChange={set('item')} />
        </View>
        <View style={styles.cell}>
          <Select label="Quantity column" placeholder="Choose a column" items={options} value={value(step.choice.quantity)} onChange={set('quantity')} />
        </View>
      </View>
      {ready ? null : <Small>Choose three different columns.</Small>}
      <Actions>
        <Button variant="outline" label="Match items" disabled={props.readOnly || !ready} onPress={props.onMatch} />
      </Actions>
    </View>
  );
}

function Preview(props: {
  outcome: MatchOutcome;
  /** The setup was saved since the file was matched. */
  stale: boolean;
  dirty: boolean;
  items: SalesSlot['items'];
  added: Readonly<Record<string, string>>;
  readOnly: boolean;
  readOnlyId: string | null;
  onAdd: (name: string, itemKey: string) => void;
  onMatchAgain: () => void;
  onSend: () => void;
}): React.JSX.Element {
  const { outcome } = props;
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };
  const itemOptions = props.items.map((item) => ({ value: item.key, label: item.name.trim() === '' ? 'Unnamed item' : item.name.trim() }));
  const lines: string[] = [];
  if (outcome.firstDate !== null && outcome.lastDate !== null) {
    lines.push(`Dates: ${formatRange(outcome.firstDate, outcome.lastDate)}, ${plural(outcome.days.length, 'day', 'days')} with rows.`);
  }
  lines.push(`Rows read: ${String(outcome.rowsRead)}. Rows matched to an item: ${String(outcome.matchedRows)}.`);
  lines.push(`Items with sales: ${String(outcome.itemsWithSales)}.`);
  if (outcome.skipped.date > 0) lines.push(`Left out ${plural(outcome.skipped.date, 'row', 'rows')} with no date Townwise can use (unreadable, before 2010 or after today).`);
  if (outcome.skipped.name > 0) lines.push(`Left out ${plural(outcome.skipped.name, 'row', 'rows')} with no item name.`);
  if (outcome.skipped.quantity > 0) lines.push(`Left out ${plural(outcome.skipped.quantity, 'row', 'rows')} whose quantity is not a number of 0 or more.`);
  const blocked = outcome.firstDate === null ? 'No row has a date Townwise can use, so there is nothing to send.'
    : outcome.overLimit > 0 ? `${plural(outcome.overLimit, 'item adds', 'items add')} up to more than 100,000 servings in a day. Check the quantity column.`
      : props.stale ? 'The setup changed since this file was matched. Match it again before sending.'
        : null;
  const shown = outcome.unmatched.slice(0, SHOWN_NAMES);
  return (
    <View style={styles.stack}>
      <Messages live="status" items={lines} />
      {outcome.unmatched.length === 0 ? null : (
        <View style={styles.stack}>
          <Small white>
            {`${plural(outcome.unmatched.length, 'name matches', 'names match')} no item’s point-of-sale names. Add the ones that are drinks you order to an item; the rest are left out.`}
          </Small>
          {shown.map((unmatched) => (
            <View key={unmatched.name} role="group" aria-label={unmatched.name} style={styles.name}>
              <Small white>{`${unmatched.name}: ${plural(unmatched.rows, 'row', 'rows')}`}</Small>
              {unmatched.name.length > SETUP_LIMITS.posName ? <Small>Longer than 80 characters, so it can’t be a point-of-sale name.</Small> : (
                <Select
                  label={`Add “${unmatched.name}” to an item`}
                  placeholder="Add to an item"
                  items={itemOptions}
                  value=""
                  onChange={(itemKey) => { if (itemKey !== '') props.onAdd(unmatched.name, itemKey); }}
                  readOnly={props.readOnly}
                  {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })}
                />
              )}
              {props.added[unmatched.name] === undefined ? null : <Small>{props.added[unmatched.name]}</Small>}
            </View>
          ))}
          {outcome.unmatched.length > SHOWN_NAMES ? <Small>{`And ${plural(outcome.unmatched.length - SHOWN_NAMES, 'more name', 'more names')}, with fewer rows.`}</Small> : null}
        </View>
      )}
      {props.dirty ? <Small white>Names you add count once the setup is saved and the file matched again.</Small> : null}
      {blocked === null ? null : <Messages live="alert" items={[blocked]} />}
      <Actions>
        <Button variant="outline" label="Send item sales" disabled={props.readOnly || blocked !== null} {...described} onPress={props.onSend} />
        <Button variant="link" label="Match again" disabled={props.readOnly} {...described} onPress={props.onMatchAgain} />
      </Actions>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space[3] },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: theme.space[4], rowGap: theme.space[4] },
  cell: { flexGrow: 1, flexBasis: 200, minWidth: 0 },
  name: { gap: theme.space[2] },
});
