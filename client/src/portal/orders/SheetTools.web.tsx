import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { listText } from '../analytics/words';
import { saveFile } from '../files/download';
import { plural } from '../format';
import { Actions, Button } from '../ui/Button';
import { LoadingLine, Messages } from '../ui/feedback';
import { Section } from '../ui/layout';
import { Small } from '../ui/text';
import type { SheetSlot } from './SetupEditor';
import { readSheetFile, SHEET_ACCEPT } from './sheetFile.web';
import { importSheet, TEMPLATE_COLUMNS, TEMPLATE_FILE_NAME, templateCsv, type SheetImport } from './template';

// The template and the sheet import on the Ordering setup page (web; the order-setup spec): download a CSV with one
// row per item, fill it in, and import it (CSV or Excel) into the draft. The browser reads the sheet; it merges by
// item name, creates the suppliers it names, says which replaced items kept what the sheet left blank, and lists
// each row it left out with why. Nothing saves until Save. Under view-as the import is disabled in place, so no
// client file is read into a staff browser.

type Shown = { kind: 'idle' } | { kind: 'reading' } | { kind: 'done'; result: SheetImport } | { kind: 'failed'; message: string };

function summary(result: SheetImport): string[] {
  const lines = [
    `Imported ${plural(result.added + result.replaced, 'item', 'items')}: ${String(result.added)} new, ${String(result.replaced)} replaced by name. `
      + 'Nothing is saved yet: check them below, then save the setup.',
  ];
  if (result.kept.length > 0) {
    lines.push(`Kept what the sheet left blank: ${result.kept.map((each) => `${each.item} (${listText(each.fields)})`).join(', ')}.`);
  }
  if (result.newSuppliers.length > 0) lines.push(`Add the delivery days of the new suppliers: ${result.newSuppliers.join(', ')}.`);
  if (result.examplesSkipped > 0) lines.push(`Left out the template’s ${plural(result.examplesSkipped, 'example row', 'example rows')}.`);
  if (result.problems.length > 0) lines.push(`Left out ${plural(result.problems.length, 'row', 'rows')} that failed a check:`);
  return lines;
}

export function SheetTools(props: SheetSlot): React.JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);
  const latest = useRef(props.draft);
  const run = useRef(0);
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };

  useEffect(() => { latest.current = props.draft; }, [props.draft]);
  useEffect(() => () => { run.current += 1; }, []);

  async function importFile(file: File): Promise<void> {
    run.current += 1;
    const mine = run.current;
    setShown({ kind: 'reading' });
    let header: string[] = [];
    const rows: { row: number; cells: string[] }[] = [];
    const outcome = await readSheetFile(file, {
      header: (cells) => { header = cells; },
      row: (cells, row) => { rows.push({ row, cells }); },
    }, () => run.current !== mine);
    if (outcome === 'cancelled' || run.current !== mine) return;
    if (outcome !== 'done') {
      setShown({ kind: 'failed', message: outcome.problem });
      return;
    }
    const merged = importSheet(header, rows, latest.current);
    if (!merged.ok) {
      setShown({
        kind: 'failed',
        message: 'missing' in merged
          ? `The sheet needs these columns: ${merged.missing.join(', ')}. Start from the template.`
          : 'The sheet has no rows after its header.',
      });
      return;
    }
    props.setDraft(merged.result.draft);
    setShown({ kind: 'done', result: merged.result });
  }

  return (
    <Section title="Fill in a sheet">
      <Small>
        Download the template, fill in one row per item in Excel, Numbers or Google Sheets, then import it. Its columns:{' '}
        {TEMPLATE_COLUMNS.join(', ')}. Put an item’s point-of-sale names in one cell, separated by semicolons, with x and a
        number for servings per sale, such as Lager Pint;Lager Pitcher x4. An item already here with the same name is
        replaced, but keeps its point-of-sale names, deal size and never run out where the sheet leaves those blank.
        Nothing saves until you save the setup.
      </Small>
      {props.locked ? null : (
        <input
          ref={input}
          type="file"
          accept={SHEET_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          data-testid="sheet-file"
          style={{ display: 'none' }}
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (chosen !== undefined) void importFile(chosen);
          }}
        />
      )}
      <Actions>
        <Button
          variant="outline"
          label="Download the template"
          onPress={() => { saveFile(new Blob([templateCsv()], { type: 'text/csv' }), TEMPLATE_FILE_NAME); }}
        />
        <Button
          variant="outline"
          label="Import a sheet"
          disabled={props.locked || shown.kind === 'reading'}
          {...described}
          onPress={() => { input.current?.click(); }}
        />
      </Actions>
      {shown.kind === 'reading' ? <LoadingLine text="Reading the sheet…" minHeight={44} /> : null}
      {shown.kind === 'failed' ? <Messages live="alert" items={[shown.message]} /> : null}
      {shown.kind === 'done' ? (
        <View style={styles.stack}>
          <Messages live="status" items={summary(shown.result)} />
          {shown.result.problems.length === 0 ? null : (
            <Messages items={shown.result.problems.map((problem) => `Row ${String(problem.row)}${problem.item === '' ? '' : `, ${problem.item}`}: ${problem.reason}`)} />
          )}
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space[3] },
});
