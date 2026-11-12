import { useId, useMemo, useRef, useState } from 'react';

import { theme } from '../../../theme';
import { EmptyState } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import { VIEW_LIMITS } from '../../viewer/limits';
import type { Delimited } from '../../viewer/text';
import type { Workbook } from '../../viewer/xlsx';
import { cutLine, ITEM, TRUNCATED } from './copy';
import { cellBorder, mono, region } from './dom.web';
import { columnLetters, shownCell } from './open';

// Tables on an item's page (P27): a CSV or TSV file as one grid, and an Excel workbook as a grid per sheet under sheet
// tabs, with column letters. Each grid is a real <table> with row numbers as row headers, in a region that scrolls
// inside itself, and draws at most VIEW_LIMITS.shownRows rows, saying so when it cuts. A file longer or wider than the
// readers read (VIEW_LIMITS.sheetRows, sheetColumns, sheets) says that too. The tabs are an ARIA tablist with one tab
// stop: Left and Right move between sheets (wrapping), Home and End go to the first and last.

const C = theme.color;

const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
  border: 0,
} as const;
const head = { ...mono, color: C.text3, fontWeight: 400, padding: '6px 12px', background: C.raised, border: cellBorder, position: 'sticky', top: 0 } as const;
const rowHead = { ...mono, color: C.text3, fontWeight: 400, padding: '6px 12px', textAlign: 'right', background: C.raised, border: cellBorder } as const;
const cell = { ...mono, color: C.text2, padding: '6px 12px', border: cellBorder, whiteSpace: 'pre-wrap', verticalAlign: 'top', maxWidth: 480 } as const;

function Grid(props: { label: string; rows: readonly (readonly string[])[]; columns: number; letters: boolean }): React.JSX.Element {
  const { columns } = props;
  const indexes = Array.from({ length: columns }, (_, index) => index);
  return (
    <div role="region" aria-label={props.label} tabIndex={0} style={region}>
      <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
        {props.letters ? (
          <thead>
            <tr>
              <th scope="col" style={head}><span style={SR_ONLY}>Row</span></th>
              {indexes.map((index) => <th key={index} scope="col" style={head}>{columnLetters(index)}</th>)}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {props.rows.map((row, at) => (
            <tr key={at}>
              <th scope="row" style={rowHead}>{at + 1}</th>
              {indexes.map((index) => <td key={index} style={cell}>{row[index] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A CSV or TSV file, as the file has its rows (ragged rows padded with empty cells). */
export function DelimitedView(props: { table: Delimited; label: string }): React.JSX.Element {
  const { table } = props;
  const shown = table.rows.slice(0, VIEW_LIMITS.shownRows);
  const columns = shown.reduce((most, row) => Math.max(most, row.length), 0);
  if (table.rows.length === 0) return <EmptyState text={ITEM.emptyFile} />;
  return (
    <Stack>
      {table.truncated ? <Small>{TRUNCATED.delimited}</Small> : null}
      {table.rows.length > shown.length ? <Small>{cutLine(shown.length, table.rows.length, 'rows')}</Small> : null}
      <Grid label={props.label} rows={shown} columns={columns} letters={false} />
    </Stack>
  );
}

function SheetTabs(props: { names: readonly string[]; selected: number; onSelect: (index: number) => void; ids: string }): React.JSX.Element {
  const { names, selected, onSelect } = props;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const last = names.length - 1;
    const moves: Readonly<Record<string, number>> = {
      ArrowRight: selected === last ? 0 : selected + 1, ArrowLeft: selected === 0 ? last : selected - 1, Home: 0, End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next);
    tabs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={ITEM.sheets} onKeyDown={onKeyDown} style={{ display: 'flex', overflowX: 'auto', borderBottom: cellBorder }}>
      {names.map((name, index) => {
        const active = index === selected;
        return (
          <button
            key={index}
            ref={(element) => { tabs.current[index] = element; }}
            type="button"
            role="tab"
            id={`${props.ids}-tab-${String(index)}`}
            aria-selected={active}
            aria-controls={`${props.ids}-panel`}
            tabIndex={active ? 0 : -1}
            onClick={() => { onSelect(index); }}
            style={{
              fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px', fontWeight: 500, minHeight: 44, padding: '0 14px',
              whiteSpace: 'nowrap', cursor: 'pointer', background: active ? C.raised : 'transparent', color: active ? C.white : C.text2,
              border: 0, borderBottom: `2px solid ${active ? C.mint : 'transparent'}`,
            }}
          >
            {name === '' ? `Sheet ${String(index + 1)}` : name}
          </button>
        );
      })}
    </div>
  );
}

/** An Excel workbook: its sheets in the workbook's order, one shown at a time. */
export function WorkbookView(props: { workbook: Workbook }): React.JSX.Element {
  const { sheets } = props.workbook;
  const ids = useId();
  const [selected, setSelected] = useState(0);
  const sheet = sheets[selected] ?? sheets[0];
  const rows = useMemo(() => (sheet === undefined ? [] : sheet.rows.slice(0, VIEW_LIMITS.shownRows).map((row) => row.map(shownCell))), [sheet]);
  if (sheet === undefined) return <EmptyState text={ITEM.emptyFile} />;
  const name = sheet.name === '' ? `Sheet ${String(selected + 1)}` : sheet.name;
  // Only a workbook with more sheets than the reader reads is truncated with no sheet truncated.
  const tooManySheets = props.workbook.truncated && !sheets.some((each) => each.truncated);
  const body = sheet.rowCount === 0 ? <EmptyState text={ITEM.emptySheet} /> : (
    <Grid label={`Sheet ${name}`} rows={rows} columns={sheet.columnCount} letters />
  );
  return (
    <Stack>
      {tooManySheets ? <Small>{TRUNCATED.sheets}</Small> : null}
      {sheets.length > 1 ? <SheetTabs names={sheets.map((each) => each.name)} selected={selected} onSelect={setSelected} ids={ids} /> : null}
      <div {...(sheets.length > 1 ? { role: 'tabpanel', id: `${ids}-panel`, 'aria-labelledby': `${ids}-tab-${String(selected)}` } : {})}>
        <Stack>
          {sheet.truncated ? <Small>{TRUNCATED.sheet}</Small> : null}
          {sheet.rowCount > rows.length ? <Small>{cutLine(rows.length, sheet.rowCount, 'rows')}</Small> : null}
          {body}
        </Stack>
      </div>
    </Stack>
  );
}
