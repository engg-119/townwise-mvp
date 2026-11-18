import { useId, useLayoutEffect, useRef, useState } from 'react';

import { theme } from '../../theme';
import { useFocusOnMount } from '../places/focus';
import { FieldFrame, useFieldIds } from '../ui/FormField';
import { MAX_SEARCH_LENGTH, suggestionLabel, suggestionLine, type PlaceSuggestion } from './places';
import { PlaceChecklistShell, type ChecklistFieldProps, type PlaceChecklistProps } from './PlaceChecklistParts';

// The places checklist on web (PlaceChecklist.tsx is native's): PlaceSearch.web's ARIA 1.2 combobox with a
// multiselectable listbox. Each option's aria-selected says whether its place is checked; the active option shows only
// by highlight and aria-activedescendant. Down and Up move the active option; Enter, and Space while an option is
// active, toggle it (with none active Space types): checking a place clears the text, which closes the list (owner,
// 2026-11-18), and unchecking leaves the list open; typing clears the active option and opens the list again. A
// mouse press toggles without taking focus from the field. A refused or full option is aria-disabled. Each option
// is named “{name}, {line}” (suggestionLine: “Street address · ” marks an address) and
// starts with a drawn 16px box, hidden from assistive technology, in Checkbox.web's colors.
// Remove gives the field focus back. Escape closes the list, then clears the text. Focus never opens or closes the
// list: it sits in the page's flow, so a list that closed on blur would move the buttons below it between a press and
// its click, and the click would miss. Nothing animates.
// Each checked place is also a chip in the field's box, before the text, in check order (D57): the selected state of
// the search. The chips are one line that scrolls sideways and leaves the text at least 160px, so the box keeps its
// height and the list under it never moves. They are out of the tab order and reached from the text: Left or Backspace
// at the start of the text moves to the last chip, Left and Right move between chips (Right from the last returns to
// the text), Delete or Backspace removes the chip in focus and moves to its neighbor, and a typed character returns to
// the end of the text, so typing always searches for one more. A key held down never crosses from the text to the
// chips or removes one, so holding Backspace to clear the text stops at its start. On a touch screen the text never
// hands over to the chips (the handoff would close the keyboard): the × and the row's Remove are the ways there. A
// chip starts with its pin's letter while the map shows one. A chip's drawn × removes it by mouse; the row's Remove
// below stays the named control. A chip whose place leaves by itself (refused, or a failed details call) hands focus
// to the text.

export type { PlaceChecklistProps } from './PlaceChecklistParts';

export function PlaceChecklist(props: PlaceChecklistProps): React.JSX.Element {
  const statusId = `${useId().replace(/:/g, '')}-status`;
  const input = useFocusOnMount<HTMLInputElement>(props.autoFocus === true);
  return (
    <PlaceChecklistShell
      props={props}
      statusId={statusId}
      onRemove={() => { input.current?.focus(); }}
      field={<WebField props={props} state={props.state} statusId={statusId} input={input} />}
    />
  );
}

const c = theme.color;

interface Cursor { list: readonly PlaceSuggestion[]; active: number; closed: boolean }

function WebField({ props, state, statusId, input }: ChecklistFieldProps & { input: React.RefObject<HTMLInputElement | null> }): React.JSX.Element {
  const ids = useFieldIds();
  const listId = `${ids.label}-list`;
  const [focused, setFocused] = useState(false);
  const off = props.disabled === true;
  const { search } = state;
  const { suggestions } = search;
  // The active suggestion and whether the list is closed belong to one answer: a new answer starts with none active
  // and the list open.
  const [cursor, setCursor] = useState<Cursor>({ list: suggestions, active: -1, closed: false });
  const { active, closed } = cursor.list === suggestions ? cursor : { active: -1, closed: false };
  const setActive = (next: (index: number) => number): void => { setCursor({ list: suggestions, active: next(active), closed: false }); };
  const setClosed = (value: boolean): void => { setCursor({ list: suggestions, active, closed: value }); };
  const open = suggestions.length > 0 && !closed;
  const activeId = open && active >= 0 ? `${listId}-${String(active)}` : undefined;
  const optionDisabled = (suggestion: PlaceSuggestion): boolean => off || state.optionOf(suggestion).disabled;
  const toggle = (suggestion: PlaceSuggestion): void => { if (!optionDisabled(suggestion)) state.toggle(suggestion); };
  const { rows } = state;
  /** The chip in focus, by its row's key: if its row leaves by itself, the text takes the focus it held. */
  const focusedChip = useRef<string | null>(null);
  const strip = useRef<HTMLUListElement>(null);
  const rowKeys = rows.map((row) => row.key).join(' ');
  useLayoutEffect(() => {
    const key = focusedChip.current;
    if (key !== null && !rowKeys.split(' ').includes(key)) {
      focusedChip.current = null;
      input.current?.focus();
    }
    // The newest chip is in view.
    if (strip.current !== null) strip.current.scrollLeft = strip.current.scrollWidth;
  }, [rowKeys, input]);
  /** The text, with the caret at its end. */
  const focusText = (): void => {
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };
  const chipId = (key: string): string => `${listId}-chip-${key}`;
  /** Focus the chip at `index`, or the text when there is none there. */
  const focusChip = (index: number): void => {
    const row = rows[index];
    (row === undefined ? input.current : document.getElementById(chipId(row.key)))?.focus();
  };

  function onChipKeyDown(event: React.KeyboardEvent<HTMLElement>, index: number, key: string): void {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        focusChip(Math.max(index - 1, 0));
        return;
      case 'ArrowRight':
        event.preventDefault();
        focusChip(index + 1);
        return;
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        // A held key removes nothing: one press, one place.
        if (off || event.repeat) return;
        // The neighbor is in the page already, so it can take focus before this chip leaves: the one after it, else
        // the one before, else the text.
        focusChip(index + 1 < rows.length ? index + 1 : index > 0 ? index - 1 : -1);
        state.remove(key);
        return;
      default:
        // A typed character belongs to the search: focus moves to the end of the text, which then receives it. A
        // composition (an IME, a dead key) starts there too.
        if ((event.key.length === 1 || event.key === 'Process' || event.key === 'Dead') && !event.metaKey && !event.ctrlKey && !event.altKey) focusText();
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowLeft':
      case 'Backspace':
        // At the start of the text, with nothing selected, the chips are next: for a fresh press only, so holding
        // Backspace to clear the text stops here, and not on a touch screen, where it would close the keyboard.
        if (rows.length === 0 || event.currentTarget.selectionStart !== 0 || event.currentTarget.selectionEnd !== 0) return;
        if (event.repeat || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)) return;
        event.preventDefault();
        focusChip(rows.length - 1);
        return;
      case 'ArrowDown':
        if (suggestions.length === 0) return;
        event.preventDefault();
        setActive((index) => (open ? Math.min(index + 1, suggestions.length - 1) : 0));
        return;
      case 'ArrowUp':
        if (!open) return;
        event.preventDefault();
        setActive((index) => Math.max(index - 1, -1));
        return;
      case 'Enter':
      case ' ': {
        const chosen = open && active >= 0 ? suggestions[active] : undefined;
        if (chosen === undefined) return;
        event.preventDefault();
        toggle(chosen);
        return;
      }
      case 'Escape':
        event.preventDefault();
        if (open) setClosed(true);
        else search.setQuery('');
        return;
      default:
    }
  }

  return (
    <FieldFrame label={props.label} {...(props.helper === undefined ? {} : { helper: props.helper })} ids={ids}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          // A press on the box's own space puts the caret in the text.
          onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, boxSizing: 'border-box', height: 44,
            padding: rows.length === 0 ? 0 : '0 6px', background: c.ground, border: `1px solid ${focused ? c.mint : c.line}`,
            outline: focused ? `2px solid ${c.focusRing}` : 'none', outlineOffset: 2, cursor: 'text',
          }}
        >
          {rows.length === 0 ? null : (
            <ul
              ref={strip}
              aria-label="Chosen places"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, flex: '0 1 auto', minWidth: 0, maxWidth: 'calc(100% - 166px)', margin: 0,
                padding: '2px 0', listStyle: 'none', overflowX: 'auto', scrollbarWidth: 'none',
              }}
            >
              {rows.map((row, index) => (
                <li key={row.key} style={{ display: 'flex', alignItems: 'stretch', flex: 'none', background: c.raised, border: `1px solid ${c.border}` }}>
                  <button
                    type="button"
                    id={chipId(row.key)}
                    tabIndex={-1}
                    aria-label={suggestionLabel(row.suggestion)}
                    aria-description={off ? undefined : 'Press Delete to remove'}
                    title={row.suggestion.name}
                    onKeyDown={(event) => { onChipKeyDown(event, index, row.key); }}
                    onFocus={() => { focusedChip.current = row.key; }}
                    onBlur={() => { if (focusedChip.current === row.key) focusedChip.current = null; }}
                    // A press selects the chip in every browser (Safari gives a pressed button no focus).
                    onMouseDown={(event) => { event.preventDefault(); event.currentTarget.focus(); }}
                    style={{
                      minWidth: 0, maxWidth: 260, minHeight: 30, margin: 0, padding: '0 4px 0 10px', border: 'none', background: 'transparent',
                      color: row.status === 'checked' && !off ? c.white : c.text3, fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default',
                    }}
                  >
                    {state.letterOf(row.key) === null ? null : (
                      <span
                        style={{
                          display: 'inline-block', width: 18, height: 18, marginRight: 6, borderRadius: 9, background: c.mint, color: c.onMint,
                          fontFamily: theme.font.mono, fontSize: 12, lineHeight: '18px', fontWeight: 600, textAlign: 'center', verticalAlign: 'middle',
                        }}
                      >
                        {state.letterOf(row.key)}
                      </span>
                    )}
                    {row.suggestion.name}
                  </button>
                  {/* Mouse only: the keyboard has Delete on the chip, and the row below has the named Remove. */}
                  <span
                    aria-hidden="true"
                    onMouseDown={(event) => { event.preventDefault(); }}
                    onClick={() => {
                      if (off) return;
                      state.remove(row.key);
                      input.current?.focus();
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: 28, color: off ? c.text3 : c.text2,
                      fontFamily: theme.font.sans, fontSize: 16, lineHeight: '20px', cursor: off ? 'default' : 'pointer',
                    }}
                  >
                    ×
                  </span>
                </li>
              ))}
            </ul>
          )}
        <input
          ref={input}
          data-ring="box"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-labelledby={ids.label}
          aria-describedby={[props.helper === undefined ? null : ids.helper, statusId].filter((id) => id !== null).join(' ')}
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          maxLength={MAX_SEARCH_LENGTH}
          disabled={off}
          value={search.query}
          onChange={(event) => {
            search.setQuery(event.target.value);
            setCursor({ list: suggestions, active: -1, closed: false });
          }}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); }}
          onBlur={() => { setFocused(false); }}
          style={{
boxSizing: 'border-box', flex: '1 1 160px', minWidth: rows.length === 0 ? 0 : 160, height: rows.length === 0 ? 42 : 32, margin: 0,
            padding: rows.length === 0 ? '0 12px' : '0 6px', background: 'transparent', color: c.white, border: 'none', outline: 'none',
            borderRadius: 0, fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px',
          }}
        />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={ids.label}
          hidden={!open}
          style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${c.border}`, borderTop: 'none', background: c.panel }}
        >
          {suggestions.map((suggestion, index) => {
            const { checked } = state.optionOf(suggestion);
            const disabled = optionDisabled(suggestion);
            const line = suggestionLine(suggestion);
            return (
              <li
                key={suggestion.placeId}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-label={suggestionLabel(suggestion)}
                aria-selected={checked}
                aria-disabled={disabled ? true : undefined}
                // Pressing keeps focus in the field, so the list stays a part of it.
                onMouseDown={(event) => { event.preventDefault(); }}
                onMouseEnter={() => { setActive(() => index); }}
                onClick={() => { toggle(suggestion); }}
                style={{
                  display: 'flex', alignItems: 'center', columnGap: 10, minHeight: 44, boxSizing: 'border-box', padding: '10px 12px',
                  cursor: disabled ? 'default' : 'pointer', borderBottom: index === suggestions.length - 1 ? 'none' : `1px solid ${c.border}`,
                  background: index === active ? c.raised : 'transparent', boxShadow: index === active ? `inset 3px 0 0 ${c.mint}` : 'none',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: 'relative', flex: 'none', width: 16, height: 16, boxSizing: 'border-box',
                    border: `1px solid ${disabled ? c.border : checked ? c.mint : c.line}`, background: checked ? c.mint : 'transparent',
                  }}
                >
                  {checked ? (
                    <span
                      style={{
                        position: 'absolute', left: 4, top: 1, width: 4, height: 8, borderRight: `2px solid ${c.onMint}`,
                        borderBottom: `2px solid ${c.onMint}`, transform: 'rotate(45deg)',
                      }}
                    />
                  ) : null}
                </span>
                <span>
                  <span style={{ display: 'block', color: disabled ? c.text3 : c.white, fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px' }}>
                    {suggestion.name}
                  </span>
                  {line === '' ? null : (
                    <span style={{ display: 'block', color: c.text2, fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px' }}>
                      {line}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </FieldFrame>
  );
}
