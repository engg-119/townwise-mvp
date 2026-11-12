import { memo, useCallback, useId, useState } from 'react';

import { theme } from '../../../theme';
import { Actions, Button } from '../../ui/Button';
import { EmptyState } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import { cellLabel, EDIT, ITEM } from './copy';
import { cellBorder, mono, region } from './dom.web';
import { addColumn, addRow, canAddColumn, canAddRow, deleteRow, setCell, type DraftRow, type Grid } from './edit';
import { head, rowHead, SheetTabs, SR_ONLY } from './GridView.web';
import { columnLetters } from './open';

// A CSV, TSV or sheet edited on its item page (P27, web): a real <table> of cells, with column numbers (a CSV) or
// letters (a sheet) and row numbers as headers, in a region that scrolls inside itself. Each cell is a textarea (an
// input would drop a line break inside a cell), as tall as its lines up to 6, named for its place, “Row 3, column 2”
// or “Row 3, column B”. Each row header has Delete; Add a row and Add a column add at the end, up to
// VIEW_LIMITS.editRows and editColumns. Rows are memoized, so typing redraws one row. A workbook shows one sheet at a
// time under the viewer's sheet tabs (GridView.web.tsx). The draft's rules (ragged rows, limits) are edit.ts's.

type Update = (update: (grid: Grid) => Grid) => void;

const C = theme.color;
const cellStyle = { border: cellBorder, padding: 0, verticalAlign: 'top', background: C.ground } as const;
const inputStyle = {
  ...mono, color: C.white, background: 'transparent', border: 0, borderRadius: 0, padding: '6px 8px', minWidth: 120, width: '100%',
  boxSizing: 'border-box', display: 'block', resize: 'vertical',
} as const;
const deleteStyle = {
  ...mono, color: C.text2, background: 'transparent', border: 0, padding: '4px 0', marginTop: 2, cursor: 'pointer', textDecoration: 'underline',
  display: 'block', marginLeft: 'auto',
} as const;

function columnName(index: number, letters: boolean): string {
  return letters ? columnLetters(index) : String(index + 1);
}

const EditRow = memo(function EditRow(props: {
  row: DraftRow;
  index: number;
  width: number;
  letters: boolean;
  disabled: boolean;
  autoFocus: boolean;
  onCell: (row: number, column: number, value: string) => void;
  onDelete: (row: number) => void;
}): React.JSX.Element {
  const { row, index, disabled, onCell } = props;
  const number = index + 1;
  return (
    <tr>
      <th scope="row" style={rowHead}>
        {number}
        <button
          type="button"
          aria-label={`Delete row ${String(number)}`}
          aria-disabled={disabled ? true : undefined}
          onClick={() => { if (!disabled) props.onDelete(index); }}
          style={deleteStyle}
        >
          {EDIT.deleteRow}
        </button>
      </th>
      {Array.from({ length: props.width }, (_, column) => {
        const value = row.text[column] ?? '';
        const label = cellLabel(number, columnName(column, props.letters));
        const focus = props.autoFocus && column === 0;
        return (
          <td key={column} style={cellStyle}>
            <textarea
              aria-label={label}
              value={value}
              readOnly={disabled}
              autoFocus={focus}
              spellCheck={false}
              rows={Math.min(6, value.split(/\r\n|\r|\n/).length)}
              onChange={(event) => { onCell(index, column, event.target.value); }}
              style={inputStyle}
            />
          </td>
        );
      })}
    </tr>
  );
});

/** One grid of inputs, with Add a row and Add a column under it. `autoFocus` puts focus in its first cell on mount. */
export function GridEditor(props: { grid: Grid; label: string; letters: boolean; disabled: boolean; autoFocus: boolean; onChange: Update }): React.JSX.Element {
  const { grid, onChange, disabled } = props;
  const onCell = useCallback((row: number, column: number, value: string) => {
    onChange((current) => setCell(current, row, column, value));
  }, [onChange]);
  const onDelete = useCallback((row: number) => { onChange((current) => deleteRow(current, row)); }, [onChange]);
  const columns = Array.from({ length: grid.width }, (_, index) => index);
  const rowsLeft = canAddRow(grid);
  const columnsLeft = canAddColumn(grid);
  return (
    <Stack>
      <div role="region" aria-label={props.label} style={region}>
        <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
          <thead>
            <tr>
              <th scope="col" style={head}><span style={SR_ONLY}>Row</span></th>
              {columns.map((index) => <th key={index} scope="col" style={head}>{columnName(index, props.letters)}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, index) => (
              <EditRow
                key={index}
                row={row}
                index={index}
                width={grid.width}
                letters={props.letters}
                disabled={disabled}
                autoFocus={props.autoFocus && index === 0}
                onCell={onCell}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
      <Actions>
        <Button variant="outline" label={EDIT.addRow} disabled={disabled || !rowsLeft} onPress={() => { onChange(addRow); }} />
        <Button variant="outline" label={EDIT.addColumn} disabled={disabled || !columnsLeft} onPress={() => { onChange(addColumn); }} />
      </Actions>
      {rowsLeft && columnsLeft ? null : <Small>{EDIT.atLimit}</Small>}
    </Stack>
  );
}

function sheetLabel(name: string | undefined, index: number): string {
  return name === undefined || name === '' ? `Sheet ${String(index + 1)}` : name;
}

/** A workbook's sheets, one grid at a time under the sheet tabs; focus starts in the first sheet's first cell. */
export function WorkbookEditor(props: {
  names: readonly string[];
  grids: readonly Grid[];
  disabled: boolean;
  onChange: (sheet: number, update: (grid: Grid) => Grid) => void;
}): React.JSX.Element {
  const { names, grids, onChange } = props;
  const ids = useId();
  const [selected, setSelected] = useState(0);
  // Only the first sheet takes focus when the editor opens; a tab chosen later keeps it.
  const [moved, setMoved] = useState(false);
  const onSheet = useCallback((update: (grid: Grid) => Grid) => { onChange(selected, update); }, [onChange, selected]);
  const grid = grids[selected] ?? grids[0];
  if (grid === undefined) return <EmptyState text={ITEM.emptyFile} />;
  const several = names.length > 1;
  return (
    <Stack>
      {several ? (
        <SheetTabs names={names} selected={selected} onSelect={(index) => { setMoved(true); setSelected(index); }} ids={ids} />
      ) : null}
      <div {...(several ? { role: 'tabpanel', id: `${ids}-panel`, 'aria-labelledby': `${ids}-tab-${String(selected)}` } : {})}>
        <GridEditor
          grid={grid}
          label={`Sheet ${sheetLabel(names[selected], selected)}`}
          letters
          disabled={props.disabled}
          autoFocus={!moved}
          onChange={onSheet}
        />
      </div>
    </Stack>
  );
}
